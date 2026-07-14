import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ZodType } from "zod";
import type { StoreConfig } from "../config/stores.js";
import {
  DetailFixtureSchema,
  NaverProductSummarySchema,
  type NaverCommerceClient,
  type NaverProductDetail,
  type NaverProductSummary,
} from "./types.js";

export class MockNaverCommerceClient implements NaverCommerceClient {
  constructor(private readonly fixtureRoot = "tests/fixtures/naver") {}

  async searchProducts(store: StoreConfig): Promise<NaverProductSummary[]> {
    const filename = store.storeKey === "A" ? "store-a-products.json" : "store-b-products.json";
    const content = await this.readJson(filename);
    return parseFixture(filename, NaverProductSummarySchema.array(), content);
  }

  async getProductDetail(
    store: StoreConfig,
    channelProductNo: string,
  ): Promise<NaverProductDetail> {
    const summaries = await this.searchProducts(store);
    const summary = summaries.find((product) => product.channelProductNo === channelProductNo);

    if (!summary) {
      throw new Error(`Mock product not found: ${store.storeKey}/${channelProductNo}`);
    }

    const details = parseFixture(
      "details.json",
      DetailFixtureSchema,
      await this.readJson("details.json"),
    );
    const detailContent = details[channelProductNo];

    if (detailContent === undefined) {
      throw new Error(`Mock detail not found: ${channelProductNo}`);
    }

    return {
      ...summary,
      detailContent,
    };
  }

  private async readJson(filename: string): Promise<unknown> {
    const path = join(this.fixtureRoot, filename);
    const content = await readFile(path, "utf8");
    return JSON.parse(content);
  }
}

function parseFixture<T>(filename: string, schema: ZodType<T>, content: unknown): T {
  const result = schema.safeParse(content);

  if (!result.success) {
    throw new Error(`Invalid mock fixture ${filename}: ${result.error.message}`);
  }

  return result.data;
}
