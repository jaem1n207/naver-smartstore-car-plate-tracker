import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { StoreConfig } from "../../src/config/stores.js";
import { LiveNaverCommerceClient } from "../../src/naver/client.js";

type ResponseHeaders = ConstructorParameters<typeof Headers>[0];

const TokenRequestBodySchema = z
  .object({
    client_id: z.string(),
    timestamp: z.coerce.number(),
    grant_type: z.string(),
    client_secret_sign: z.string(),
    type: z.string(),
  })
  .strict();

const SearchRequestBodySchema = z.object({
  page: z.number(),
  size: z.number(),
  orderType: z.string(),
});

const store: StoreConfig = {
  storeKey: "A",
  storeName: "Store A",
  storeDisplayName: "Store A (store-a)",
  storeBaseUrl: "https://example.com/store-a",
  clientId: "store-a-client",
  clientSecret: "$2a$04$abcdefghijklmnopqrstuu",
};

describe("LiveNaverCommerceClient", () => {
  it("requests a SELF token as form data without raw client secret leakage", async () => {
    const queuedFetch = createQueuedFetch([
      tokenResponse("access-token"),
      searchResponse({ contents: [], last: true }),
    ]);
    const client = new LiveNaverCommerceClient({
      baseUrl: "https://api.example.com",
      fetchImpl: queuedFetch.fetchImpl,
    });

    await client.searchProducts(store);

    const tokenCall = getCall(queuedFetch.calls, 0);
    const tokenBody = TokenRequestBodySchema.parse(parseFormBody(tokenCall));
    const rawTokenBody = stringifyBody(tokenCall);
    const decodedSignature = Buffer.from(tokenBody.client_secret_sign, "base64").toString("utf8");

    expect(tokenCall.url).toBe("https://api.example.com/v1/oauth2/token");
    expect(new Headers(tokenCall.init?.headers).get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(tokenBody).toMatchObject({
      client_id: "store-a-client",
      grant_type: "client_credentials",
      type: "SELF",
    });
    expect(decodedSignature).toContain("$2a$04$");
    expect(rawTokenBody).not.toContain(store.clientSecret);
  });

  it("includes the Bearer token on API requests", async () => {
    const queuedFetch = createQueuedFetch([
      tokenResponse("access-token"),
      searchResponse({ contents: [], last: true }),
    ]);
    const client = new LiveNaverCommerceClient({
      baseUrl: "https://api.example.com",
      fetchImpl: queuedFetch.fetchImpl,
    });

    await client.searchProducts(store);

    const searchCall = getCall(queuedFetch.calls, 1);
    expect(new Headers(searchCall.init?.headers).get("Authorization")).toBe("Bearer access-token");
  });

  it("refreshes once after GW.AUTHN and then succeeds", async () => {
    const queuedFetch = createQueuedFetch([
      tokenResponse("expired-token"),
      jsonResponse({ code: "GW.AUTHN" }, 401),
      tokenResponse("fresh-token"),
      searchResponse({
        contents: [
          {
            originProductNo: 1001,
            channelProducts: [
              {
                channelProductNo: 2001,
                channelProductName: "Fresh product",
                statusType: "SALE",
              },
            ],
          },
        ],
        last: true,
      }),
    ]);
    const client = new LiveNaverCommerceClient({
      baseUrl: "https://api.example.com",
      fetchImpl: queuedFetch.fetchImpl,
    });

    await expect(client.searchProducts(store)).resolves.toEqual([
      {
        originProductNo: "1001",
        channelProductNo: "2001",
        productName: "Fresh product",
        productStatus: "SALE",
        displayStatus: "",
      },
    ]);

    expect(new Headers(getCall(queuedFetch.calls, 1).init?.headers).get("Authorization")).toBe(
      "Bearer expired-token",
    );
    expect(new Headers(getCall(queuedFetch.calls, 3).init?.headers).get("Authorization")).toBe(
      "Bearer fresh-token",
    );
  });

  it("pages through search responses and filters deleted products", async () => {
    const queuedFetch = createQueuedFetch([
      tokenResponse("access-token"),
      searchResponse({
        contents: [
          {
            originProductNo: 1001,
            channelProducts: [
              {
                channelProductNo: 2001,
                channelProductName: "Visible product",
                statusType: "SALE",
              },
            ],
          },
        ],
        totalPages: 2,
      }),
      searchResponse({
        contents: [
          {
            originProductNo: 1002,
            channelProducts: [
              {
                channelProductNo: 2002,
                channelProductName: "Deleted product",
                statusType: "DELETE",
              },
            ],
          },
        ],
        last: true,
      }),
    ]);
    const client = new LiveNaverCommerceClient({
      baseUrl: "https://api.example.com",
      fetchImpl: queuedFetch.fetchImpl,
    });

    const products = await client.searchProducts(store);
    const firstSearchBody = SearchRequestBodySchema.parse(
      parseJsonBody(getCall(queuedFetch.calls, 1)),
    );
    const secondSearchBody = SearchRequestBodySchema.parse(
      parseJsonBody(getCall(queuedFetch.calls, 2)),
    );

    expect(firstSearchBody.page).toBe(1);
    expect(secondSearchBody.page).toBe(2);
    expect(products).toEqual([
      {
        originProductNo: "1001",
        channelProductNo: "2001",
        productName: "Visible product",
        productStatus: "SALE",
        displayStatus: "",
      },
    ]);
  });

  it("fails closed when search contents are missing", async () => {
    const queuedFetch = createQueuedFetch([
      tokenResponse("access-token"),
      searchResponse({ last: true }),
    ]);
    const client = new LiveNaverCommerceClient({
      baseUrl: "https://api.example.com",
      fetchImpl: queuedFetch.fetchImpl,
    });

    await expect(client.searchProducts(store)).rejects.toThrow(/contents/);
  });

  it("fails closed when a search content entry is missing channelProducts", async () => {
    const queuedFetch = createQueuedFetch([
      tokenResponse("access-token"),
      searchResponse({
        contents: [{ originProductNo: 1001 }],
        last: true,
      }),
    ]);
    const client = new LiveNaverCommerceClient({
      baseUrl: "https://api.example.com",
      fetchImpl: queuedFetch.fetchImpl,
    });

    await expect(client.searchProducts(store)).rejects.toThrow(/channelProducts/);
  });

  it("fails closed when search pagination signal is missing", async () => {
    const queuedFetch = createQueuedFetch([
      tokenResponse("access-token"),
      searchResponse({ contents: [] }),
    ]);
    const client = new LiveNaverCommerceClient({
      baseUrl: "https://api.example.com",
      fetchImpl: queuedFetch.fetchImpl,
    });

    await expect(client.searchProducts(store)).rejects.toThrow(
      "Naver product search response missing pagination signal",
    );
  });

  it("accepts totalPages zero as a valid empty search result", async () => {
    const queuedFetch = createQueuedFetch([
      tokenResponse("access-token"),
      searchResponse({ contents: [], totalPages: 0 }),
    ]);
    const client = new LiveNaverCommerceClient({
      baseUrl: "https://api.example.com",
      fetchImpl: queuedFetch.fetchImpl,
    });

    await expect(client.searchProducts(store)).resolves.toEqual([]);
    expect(queuedFetch.calls).toHaveLength(2);
  });

  it.each([-1, 1.5, "invalid"])("rejects invalid totalPages value %s", async (totalPages) => {
    const queuedFetch = createQueuedFetch([
      tokenResponse("access-token"),
      searchResponse({ contents: [], totalPages }),
    ]);
    const client = new LiveNaverCommerceClient({
      baseUrl: "https://api.example.com",
      fetchImpl: queuedFetch.fetchImpl,
    });

    await expect(client.searchProducts(store)).rejects.toThrow(/totalPages/);
  });

  it("fails closed when detail content is missing", async () => {
    const queuedFetch = createQueuedFetch([
      tokenResponse("access-token"),
      jsonResponse({
        originProduct: {
          originProductNo: 1001,
          name: "Missing detail content",
          statusType: "SALE",
        },
        smartstoreChannelProduct: {
          channelProductNo: 2001,
          channelProductName: "Missing detail content",
        },
      }),
    ]);
    const client = new LiveNaverCommerceClient({
      baseUrl: "https://api.example.com",
      fetchImpl: queuedFetch.fetchImpl,
    });

    await expect(client.getProductDetail(store, "2001")).rejects.toThrow(/detailContent/);
  });

  it("retries a rate-limited product detail request with exponential backoff", async () => {
    const sleeps: number[] = [];
    const queuedFetch = createQueuedFetch([
      tokenResponse("access-token"),
      rateLimitedResponse(),
      jsonResponse({
        originProduct: {
          originProductNo: 1001,
          name: "Recovered product",
          detailContent: "<p>차량번호 123가4567</p>",
          statusType: "SALE",
        },
        smartstoreChannelProduct: {
          channelProductNo: 2001,
          channelProductName: "Recovered product",
        },
      }),
    ]);
    const client = new LiveNaverCommerceClient({
      baseUrl: "https://api.example.com",
      fetchImpl: queuedFetch.fetchImpl,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
      random: () => 0,
    });

    await expect(client.getProductDetail(store, "2001")).resolves.toMatchObject({
      channelProductNo: "2001",
      productName: "Recovered product",
    });
    expect(sleeps).toEqual([1_000]);
    expect(queuedFetch.calls).toHaveLength(3);
  });

  it("honors Retry-After on rate-limited requests", async () => {
    const sleeps: number[] = [];
    const queuedFetch = createQueuedFetch([
      tokenResponse("access-token"),
      rateLimitedResponse({ "Retry-After": "3" }),
      searchResponse({ contents: [], last: true }),
    ]);
    const client = new LiveNaverCommerceClient({
      baseUrl: "https://api.example.com",
      fetchImpl: queuedFetch.fetchImpl,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });

    await expect(client.searchProducts(store)).resolves.toEqual([]);
    expect(sleeps).toEqual([3_000]);
  });

  it("fails after bounded rate-limit retries", async () => {
    const sleeps: number[] = [];
    const queuedFetch = createQueuedFetch([
      tokenResponse("access-token"),
      rateLimitedResponse(),
      rateLimitedResponse(),
      rateLimitedResponse(),
      rateLimitedResponse(),
      rateLimitedResponse(),
    ]);
    const client = new LiveNaverCommerceClient({
      baseUrl: "https://api.example.com",
      fetchImpl: queuedFetch.fetchImpl,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
      random: () => 0,
    });

    await expect(client.searchProducts(store)).rejects.toThrow(
      "Naver API rate limit exceeded after 5 attempts for /v1/products/search",
    );
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it("paces repeated API calls from Naver rate-limit headers", async () => {
    const sleeps: number[] = [];
    const queuedFetch = createQueuedFetch([
      tokenResponse("access-token"),
      searchResponse(
        { contents: [], totalPages: 2 },
        {
          "GNCP-GW-RateLimit-Replenish-Rate": "2",
          "GNCP-GW-RateLimit-Remaining": "0",
        },
      ),
      searchResponse({ contents: [], last: true }),
    ]);
    const client = new LiveNaverCommerceClient({
      baseUrl: "https://api.example.com",
      fetchImpl: queuedFetch.fetchImpl,
      now: () => 10_000,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });

    await expect(client.searchProducts(store)).resolves.toEqual([]);
    expect(sleeps).toEqual([500]);
  });
});

interface QueuedFetch {
  readonly fetchImpl: typeof fetch;
  readonly calls: FetchCall[];
}

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function createQueuedFetch(responses: Response[]): QueuedFetch {
  const queue = [...responses];
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push({ url: stringifyFetchInput(input), init });

    const response = queue.shift();

    if (!response) {
      throw new Error("Unexpected fetch call");
    }

    return Promise.resolve(response);
  };

  return { fetchImpl, calls };
}

function tokenResponse(accessToken: string): Response {
  return jsonResponse({ access_token: accessToken, expires_in: 300 });
}

function searchResponse(body: unknown, headers?: ResponseHeaders): Response {
  return jsonResponse(body, 200, headers);
}

function rateLimitedResponse(headers?: ResponseHeaders): Response {
  return jsonResponse({ code: "GW.RATE_LIMIT" }, 429, headers);
}

function jsonResponse(body: unknown, status = 200, headers?: ResponseHeaders): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json");

  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}

function stringifyFetchInput(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function getCall(calls: FetchCall[], index: number): FetchCall {
  const call = calls[index];

  if (!call) {
    throw new Error(`Missing fetch call at index ${String(index)}`);
  }

  return call;
}

function parseJsonBody(call: FetchCall): unknown {
  const body = stringifyBody(call);
  const parsed: unknown = JSON.parse(body);
  return parsed;
}

function parseFormBody(call: FetchCall): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(stringifyBody(call)));
}

function stringifyBody(call: FetchCall): string {
  if (!call.init || typeof call.init.body !== "string") {
    throw new Error(`Fetch call ${call.url} does not have a string body`);
  }

  return call.init.body;
}
