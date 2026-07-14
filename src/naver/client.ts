import pLimit from "p-limit";
import { z } from "zod";
import type { StoreConfig } from "../config/stores.js";
import { createClientSecretSign, TokenCache } from "./auth.js";
import type { NaverCommerceClient, NaverProductDetail, NaverProductSummary } from "./types.js";

interface NaverClientOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly tokenCache?: TokenCache;
  readonly maxRateLimitRetries?: number;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface FetchJsonResult {
  readonly body: unknown;
  readonly authExpired: boolean;
}

const ProductIdSchema = z.union([z.string(), z.number()]).transform((value) => String(value));

const ProductSearchResponseSchema = z.object({
  contents: z.array(
    z.object({
      originProductNo: ProductIdSchema.optional(),
      channelProducts: z.array(
        z.object({
          channelProductNo: ProductIdSchema.optional(),
          name: z.string().optional(),
          channelProductName: z.string().optional(),
          statusType: z.string().optional(),
          channelProductDisplayStatusType: z.string().optional(),
        }),
      ),
    }),
  ),
  last: z.boolean().optional(),
  totalPages: z.number().int().positive().optional(),
});

type ProductSearchResponse = z.infer<typeof ProductSearchResponseSchema>;

const ProductDetailResponseSchema = z.object({
  originProduct: z.object({
    originProductNo: ProductIdSchema.optional(),
    name: z.string().optional(),
    detailContent: z.string(),
    statusType: z.string().optional(),
  }),
  smartstoreChannelProduct: z
    .object({
      channelProductName: z.string().optional(),
      channelProductDisplayStatusType: z.string().optional(),
      channelProductNo: ProductIdSchema.optional(),
    })
    .optional(),
});

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

const GatewayErrorSchema = z.object({
  code: z.string().optional(),
});

const DEFAULT_MAX_RATE_LIMIT_RETRIES = 4;
const INITIAL_RATE_LIMIT_BACKOFF_MS = 1_000;
const MAX_RATE_LIMIT_JITTER_MS = 250;

export class LiveNaverCommerceClient implements NaverCommerceClient {
  private readonly fetchImpl: typeof fetch;
  private readonly tokenCache: TokenCache;
  private readonly detailLimit = pLimit(1);
  private readonly maxRateLimitRetries: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly nextRequestAtByResource = new Map<string, number>();

  constructor(private readonly options: NaverClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tokenCache = options.tokenCache ?? new TokenCache();
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? sleep;
  }

  async searchProducts(store: StoreConfig): Promise<NaverProductSummary[]> {
    const products: NaverProductSummary[] = [];
    let page = 1;
    let last = false;

    while (!last) {
      const response = ProductSearchResponseSchema.parse(
        await this.request(store, "/v1/products/search", {
          method: "POST",
          body: JSON.stringify({
            page,
            size: 100,
            orderType: "NO",
          }),
        }),
      );

      for (const content of response.contents) {
        for (const channelProduct of content.channelProducts) {
          if (!channelProduct.channelProductNo) {
            continue;
          }

          products.push({
            originProductNo: content.originProductNo ?? "",
            channelProductNo: channelProduct.channelProductNo,
            productName: channelProduct.channelProductName ?? channelProduct.name ?? "",
            productStatus: channelProduct.statusType ?? "",
            displayStatus: channelProduct.channelProductDisplayStatusType ?? "",
          });
        }
      }

      last = isLastSearchPage(response, page);
      page += 1;
    }

    return products.filter((product) => product.productStatus !== "DELETE");
  }

  async getProductDetail(
    store: StoreConfig,
    channelProductNo: string,
  ): Promise<NaverProductDetail> {
    return this.detailLimit(async () => {
      const response = await this.request(
        store,
        `/v2/products/channel-products/${encodeURIComponent(channelProductNo)}`,
        { method: "GET" },
      );
      const parsed = ProductDetailResponseSchema.parse(response);

      return {
        originProductNo: parsed.originProduct.originProductNo ?? "",
        channelProductNo: parsed.smartstoreChannelProduct?.channelProductNo ?? channelProductNo,
        productName:
          parsed.smartstoreChannelProduct?.channelProductName ?? parsed.originProduct.name ?? "",
        productStatus: parsed.originProduct.statusType ?? "",
        displayStatus: parsed.smartstoreChannelProduct?.channelProductDisplayStatusType ?? "",
        detailContent: parsed.originProduct.detailContent,
      };
    });
  }

  private async request(store: StoreConfig, path: string, init: RequestInit): Promise<unknown> {
    const firstToken = await this.getAccessToken(store);
    const firstResponse = await this.fetchJson(path, firstToken, init);

    if (!firstResponse.authExpired) {
      return firstResponse.body;
    }

    this.tokenCache.clear(store.storeKey);
    const refreshedToken = await this.getAccessToken(store);
    const secondResponse = await this.fetchJson(path, refreshedToken, init);

    if (secondResponse.authExpired) {
      throw new Error(`Naver API authentication failed after refresh: ${path}`);
    }

    return secondResponse.body;
  }

  private async getAccessToken(store: StoreConfig): Promise<string> {
    const cached = this.tokenCache.get(store.storeKey);

    if (cached) {
      return cached;
    }

    const timestamp = Date.now();
    const tokenBody = new URLSearchParams({
      client_id: store.clientId,
      timestamp: String(timestamp),
      grant_type: "client_credentials",
      client_secret_sign: createClientSecretSign({
        clientId: store.clientId,
        clientSecret: store.clientSecret,
        timestamp,
      }),
      type: "SELF",
    });
    const response = await this.fetchImpl(`${this.options.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });

    if (!response.ok) {
      throw new Error(`Naver token request failed with HTTP ${String(response.status)}`);
    }

    const body = TokenResponseSchema.parse(await readJson(response));

    this.tokenCache.set(store.storeKey, {
      accessToken: body.access_token,
      expiresIn: body.expires_in,
    });

    return body.access_token;
  }

  private async fetchJson(
    path: string,
    accessToken: string,
    init: RequestInit,
  ): Promise<FetchJsonResult> {
    return this.fetchJsonAttempt(path, accessToken, init, 0);
  }

  private async fetchJsonAttempt(
    path: string,
    accessToken: string,
    init: RequestInit,
    rateLimitRetryCount: number,
  ): Promise<FetchJsonResult> {
    await this.waitForRateLimitWindow(path);
    const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
      ...init,
      headers: createJsonHeaders(accessToken, init.headers),
    });
    this.observeRateLimitHeaders(path, response.headers);

    if (response.status === 429) {
      if (rateLimitRetryCount >= this.maxRateLimitRetries) {
        throw new Error(
          `Naver API rate limit exceeded after ${String(rateLimitRetryCount + 1)} attempts for ${path}`,
        );
      }

      const retryDelay = rateLimitRetryDelay({
        attempt: rateLimitRetryCount,
        headers: response.headers,
        now: this.now(),
        random: this.random(),
      });
      await this.sleep(retryDelay);
      return this.fetchJsonAttempt(path, accessToken, init, rateLimitRetryCount + 1);
    }

    if (response.status === 401) {
      const body = GatewayErrorSchema.parse(await readJsonOrEmpty(response));

      if (body.code === "GW.AUTHN") {
        return { body: {}, authExpired: true };
      }

      throw new Error(`Naver API request failed for ${path} with HTTP 401`);
    }

    if (!response.ok) {
      throw new Error(`Naver API request failed for ${path} with HTTP ${String(response.status)}`);
    }

    return { body: await readJson(response), authExpired: false };
  }

  private async waitForRateLimitWindow(path: string): Promise<void> {
    const resource = rateLimitResource(path);
    const nextRequestAt = this.nextRequestAtByResource.get(resource);

    if (nextRequestAt === undefined) {
      return;
    }

    const waitMilliseconds = Math.max(0, nextRequestAt - this.now());

    if (waitMilliseconds > 0) {
      await this.sleep(waitMilliseconds);
    }
  }

  private observeRateLimitHeaders(path: string, headers: Headers): void {
    const replenishRate = positiveNumberHeader(headers, "GNCP-GW-RateLimit-Replenish-Rate");

    if (replenishRate === undefined) {
      return;
    }

    const resource = rateLimitResource(path);
    const intervalMilliseconds = Math.ceil(1_000 / replenishRate);
    this.nextRequestAtByResource.set(resource, this.now() + intervalMilliseconds);
  }
}

interface RateLimitRetryDelayInput {
  readonly attempt: number;
  readonly headers: Headers;
  readonly now: number;
  readonly random: number;
}

function rateLimitRetryDelay(input: RateLimitRetryDelayInput): number {
  const retryAfter = retryAfterMilliseconds(input.headers.get("Retry-After"), input.now);

  if (retryAfter !== undefined) {
    return retryAfter;
  }

  const exponentialBackoff = INITIAL_RATE_LIMIT_BACKOFF_MS * 2 ** input.attempt;
  const jitter = Math.floor(input.random * MAX_RATE_LIMIT_JITTER_MS);
  return exponentialBackoff + jitter;
}

function retryAfterMilliseconds(value: string | null, now: number): number | undefined {
  if (value === null) {
    return undefined;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }

  const retryAt = Date.parse(value);

  if (Number.isNaN(retryAt)) {
    return undefined;
  }

  return Math.max(0, retryAt - now);
}

function positiveNumberHeader(headers: Headers, name: string): number | undefined {
  const parsed = Number(headers.get(name));

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function rateLimitResource(path: string): string {
  const channelProductDetailPrefix = "/v2/products/channel-products/";

  if (path.startsWith(channelProductDetailPrefix)) {
    return `${channelProductDetailPrefix}:channelProductNo`;
  }

  return path;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function createJsonHeaders(accessToken: string, headers?: RequestInit["headers"]): Headers {
  const nextHeaders = new Headers(headers);

  if (!nextHeaders.has("Content-Type")) {
    nextHeaders.set("Content-Type", "application/json");
  }

  nextHeaders.set("Authorization", `Bearer ${accessToken}`);
  return nextHeaders;
}

async function readJson(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  return body;
}

async function readJsonOrEmpty(response: Response): Promise<unknown> {
  try {
    return await readJson(response);
  } catch {
    return {};
  }
}

function isLastSearchPage(response: ProductSearchResponse, page: number): boolean {
  if (response.last !== undefined) {
    return response.last;
  }

  if (response.totalPages !== undefined) {
    return page >= response.totalPages;
  }

  throw new Error("Naver product search response missing pagination signal");
}
