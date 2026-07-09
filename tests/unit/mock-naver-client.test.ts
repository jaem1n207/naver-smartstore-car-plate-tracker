import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { StoreConfig } from "../../src/config/stores.js";
import { MockNaverCommerceClient } from "../../src/naver/mock-client.js";

const storeA: StoreConfig = {
  storeKey: "A",
  storeName: "Store A",
  storeDisplayName: "Store A (store-a)",
  storeBaseUrl: "https://example.com/store-a",
  clientId: "store-a-client",
  clientSecret: "store-a-secret",
  accountId: "store-a-account",
};

const storeB: StoreConfig = {
  storeKey: "B",
  storeName: "Store B",
  storeDisplayName: "Store B (store-b)",
  storeBaseUrl: "https://example.com/store-b",
  clientId: "store-b-client",
  clientSecret: "store-b-secret",
  accountId: "store-b-account",
};

describe("MockNaverCommerceClient", () => {
  it("selects store-specific product fixtures", async () => {
    const client = new MockNaverCommerceClient();

    await expect(client.searchProducts(storeA)).resolves.toHaveLength(3);
    await expect(client.searchProducts(storeB)).resolves.toHaveLength(2);
  });

  it("returns product detail by channel product number", async () => {
    const client = new MockNaverCommerceClient();

    await expect(client.getProductDetail(storeA, "2001")).resolves.toMatchObject({
      originProductNo: "1001",
      channelProductNo: "2001",
      detailContent: "<table><tr><th>차량번호</th><td>123 가 4567</td></tr></table>",
    });
  });

  it("throws useful errors for missing mock products and details", async () => {
    const client = new MockNaverCommerceClient();

    await expect(client.getProductDetail(storeA, "9999")).rejects.toThrow(
      "Mock product not found: A/9999",
    );

    const fixtureRoot = await createFixtureRoot({
      products: [
        {
          originProductNo: "1001",
          channelProductNo: "2001",
          productName: "Missing detail",
          productStatus: "SALE",
          displayStatus: "ON",
        },
      ],
      details: {},
    });
    const customClient = new MockNaverCommerceClient(fixtureRoot);

    await expect(customClient.getProductDetail(storeA, "2001")).rejects.toThrow(
      "Mock detail not found: 2001",
    );
  });

  it("adds fixture filename context to invalid fixture errors", async () => {
    const fixtureRoot = await createFixtureRoot({
      products: [{ channelProductNo: "2001" }],
      details: {},
    });
    const client = new MockNaverCommerceClient(fixtureRoot);

    await expect(client.searchProducts(storeA)).rejects.toThrow(
      "Invalid mock fixture store-a-products.json",
    );
  });
});

async function createFixtureRoot(input: {
  products: unknown[];
  details: Record<string, string>;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mock-naver-"));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "store-a-products.json"), JSON.stringify(input.products), "utf8");
  await writeFile(join(root, "store-b-products.json"), JSON.stringify([], null, 2), "utf8");
  await writeFile(join(root, "details.json"), JSON.stringify(input.details), "utf8");

  return root;
}
