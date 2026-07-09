import type { AppEnv } from "./env.js";

export type StoreKey = "A" | "B";

export interface StoreConfig {
  readonly storeKey: StoreKey;
  readonly storeName: string;
  readonly storeBaseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly accountId: string;
}

export function loadStores(env: AppEnv): StoreConfig[] {
  return [
    {
      storeKey: "A",
      storeName: env.raw.STORE_A_NAME,
      storeBaseUrl: env.raw.STORE_A_BASE_URL,
      clientId: env.raw.STORE_A_CLIENT_ID,
      clientSecret: env.raw.STORE_A_CLIENT_SECRET,
      accountId: env.raw.STORE_A_ACCOUNT_ID,
    },
    {
      storeKey: "B",
      storeName: env.raw.STORE_B_NAME,
      storeBaseUrl: env.raw.STORE_B_BASE_URL,
      clientId: env.raw.STORE_B_CLIENT_ID,
      clientSecret: env.raw.STORE_B_CLIENT_SECRET,
      accountId: env.raw.STORE_B_ACCOUNT_ID,
    },
  ];
}
