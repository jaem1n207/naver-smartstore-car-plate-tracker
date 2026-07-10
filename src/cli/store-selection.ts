import type { StoreConfig } from "../config/stores.js";

const STORE_OPTION = "--store";

export function selectStoresFromArgs(
  stores: readonly StoreConfig[],
  args: readonly string[],
): StoreConfig[] {
  const requestedSlugs = parseStoreSlugs(args);

  if (requestedSlugs.length === 0) {
    return [...stores];
  }

  const storesBySlug = new Map(stores.map((store) => [storeSlug(store), store]));
  const availableSlugs = [...storesBySlug.keys()].join(", ");
  const selectedStores: StoreConfig[] = [];
  const selectedStoreKeys = new Set<StoreConfig["storeKey"]>();

  for (const requestedSlug of requestedSlugs) {
    const store = storesBySlug.get(requestedSlug);

    if (store === undefined) {
      throw new Error(`스토어를 찾을 수 없습니다: ${requestedSlug} (사용 가능: ${availableSlugs})`);
    }

    if (!selectedStoreKeys.has(store.storeKey)) {
      selectedStores.push(store);
      selectedStoreKeys.add(store.storeKey);
    }
  }

  return selectedStores;
}

function parseStoreSlugs(args: readonly string[]): string[] {
  const slugs: string[] = [];

  for (const argument of args) {
    if (argument.startsWith(`${STORE_OPTION}=`)) {
      slugs.push(nonEmptySlug(argument.slice(`${STORE_OPTION}=`.length)));
      continue;
    }

    throw new Error(`지원하지 않는 인수입니다: ${argument}`);
  }

  return slugs;
}

function nonEmptySlug(value: string): string {
  const slug = value.trim();

  if (slug.length === 0) {
    throw new Error("--store에 스마트스토어 URL slug를 입력해야 합니다");
  }

  return slug;
}

function storeSlug(store: StoreConfig): string {
  const slug = new URL(store.storeBaseUrl).pathname.split("/").filter(Boolean).at(-1);

  if (slug === undefined) {
    throw new Error(`${store.storeDisplayName} 스토어 URL에서 slug를 찾을 수 없습니다`);
  }

  return slug;
}
