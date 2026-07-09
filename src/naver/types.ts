import { z } from "zod";
import type { StoreConfig } from "../config/stores.js";

export const NaverProductSummarySchema = z.object({
  originProductNo: z.string(),
  channelProductNo: z.string(),
  productName: z.string(),
  productStatus: z.string(),
  displayStatus: z.string().optional(),
});

export const NaverProductDetailSchema = NaverProductSummarySchema.extend({
  detailContent: z.string(),
});

export const DetailFixtureSchema = z.record(z.string(), z.string());

export type NaverProductSummary = z.infer<typeof NaverProductSummarySchema>;
export type NaverProductDetail = z.infer<typeof NaverProductDetailSchema>;

export type NaverCommerceClient = {
  searchProducts(store: StoreConfig): Promise<NaverProductSummary[]>;
  getProductDetail(store: StoreConfig, channelProductNo: string): Promise<NaverProductDetail>;
};
