import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
    return NaverProductSummarySchema.array().parse(content);
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

    const details = DetailFixtureSchema.parse(await this.readJson("details.json"));
    const detailContent = details[channelProductNo];

    if (!detailContent) {
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
