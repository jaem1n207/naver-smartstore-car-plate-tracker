import type { AppEnv } from "./env.js";

export type StoreKey = "A" | "B";

export interface StoreConfig {
  readonly storeKey: StoreKey;
  readonly storeName: string;
  readonly storeDisplayName: string;
  readonly storeBaseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly accountId: string;
}

export function loadStores(env: AppEnv): [StoreConfig, StoreConfig] {
  return [
    {
      storeKey: "A",
      storeName: env.raw.STORE_A_NAME,
      storeDisplayName: createStoreDisplayName(env.raw.STORE_A_NAME, env.raw.STORE_A_BASE_URL),
      storeBaseUrl: env.raw.STORE_A_BASE_URL,
      clientId: env.raw.STORE_A_CLIENT_ID,
      clientSecret: env.raw.STORE_A_CLIENT_SECRET,
      accountId: env.raw.STORE_A_ACCOUNT_ID,
    },
    {
      storeKey: "B",
      storeName: env.raw.STORE_B_NAME,
      storeDisplayName: createStoreDisplayName(env.raw.STORE_B_NAME, env.raw.STORE_B_BASE_URL),
      storeBaseUrl: env.raw.STORE_B_BASE_URL,
      clientId: env.raw.STORE_B_CLIENT_ID,
      clientSecret: env.raw.STORE_B_CLIENT_SECRET,
      accountId: env.raw.STORE_B_ACCOUNT_ID,
    },
  ];
}

export function createStoreDisplayName(storeName: string, storeBaseUrl: string): string {
  const pathnameSegments = new URL(storeBaseUrl).pathname.split("/").filter(hasText);
  const storeSlug = pathnameSegments.at(-1);

  if (storeSlug === undefined || storeName.includes(`(${storeSlug})`)) {
    return storeName;
  }

  return `${storeName} (${storeSlug})`;
}

function hasText(value: string): boolean {
  return value.length > 0;
}
