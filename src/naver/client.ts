import pLimit from "p-limit";
import { z } from "zod";
import type { StoreConfig } from "../config/stores.js";
import { createClientSecretSign, TokenCache } from "./auth.js";
import type { NaverCommerceClient, NaverProductDetail, NaverProductSummary } from "./types.js";

interface NaverClientOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly tokenCache?: TokenCache;
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

export class LiveNaverCommerceClient implements NaverCommerceClient {
  private readonly fetchImpl: typeof fetch;
  private readonly tokenCache: TokenCache;
  private readonly detailLimit = pLimit(3);

  constructor(private readonly options: NaverClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tokenCache = options.tokenCache ?? new TokenCache();
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
    const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
      ...init,
      headers: createJsonHeaders(accessToken, init.headers),
    });

    if (response.status === 401) {
      const body = GatewayErrorSchema.parse(await readJsonOrEmpty(response));

      if (body.code === "GW.AUTHN") {
        return { body: {}, authExpired: true };
      }

      throw new Error(`Naver API request failed for ${path} with HTTP 401`);
    }

    if (response.status === 429) {
      throw new Error(`Naver API rate limit exceeded for ${path}`);
    }

    if (!response.ok) {
      throw new Error(`Naver API request failed for ${path} with HTTP ${String(response.status)}`);
    }

    return { body: await readJson(response), authExpired: false };
  }
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
