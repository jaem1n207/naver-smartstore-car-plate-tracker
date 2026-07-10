import { describe, expect, it } from "vitest";
import type { StoreConfig } from "../../src/config/stores.js";
import { selectStoresFromArgs } from "../../src/cli/store-selection.js";

const stores: readonly [StoreConfig, StoreConfig] = [
  {
    storeKey: "A",
    storeName: "Store A",
    storeDisplayName: "Store A (store-a)",
    storeBaseUrl: "https://example.com/store-a",
    clientId: "store-a-client",
    clientSecret: "store-a-secret",
  },
  {
    storeKey: "B",
    storeName: "Store B",
    storeDisplayName: "Store B (store-b)",
    storeBaseUrl: "https://example.com/store-b",
    clientId: "store-b-client",
    clientSecret: "store-b-secret",
  },
];

describe("selectStoresFromArgs", () => {
  it("selects a configured store by Smartstore URL slug", () => {
    const selected = selectStoresFromArgs(stores, ["--store=store-a"]);

    expect(selected.map((store) => store.storeDisplayName)).toEqual(["Store A (store-a)"]);
  });

  it("selects all configured stores when no store argument is provided", () => {
    expect(selectStoresFromArgs(stores, [])).toEqual(stores);
  });

  it("rejects an unknown store slug with the configured choices", () => {
    expect(() => selectStoresFromArgs(stores, ["--store=unknown"])).toThrow(
      "스토어를 찾을 수 없습니다: unknown (사용 가능: store-a, store-b)",
    );
  });

  it("deduplicates repeated store selections", () => {
    const selected = selectStoresFromArgs(stores, ["--store=store-a", "--store=store-a"]);

    expect(selected.map((store) => store.storeKey)).toEqual(["A"]);
  });

  it("rejects an empty store slug", () => {
    expect(() => selectStoresFromArgs(stores, ["--store="])).toThrow(
      "--store에 스마트스토어 URL slug를 입력해야 합니다",
    );
  });

  it("rejects unsupported CLI arguments", () => {
    expect(() => selectStoresFromArgs(stores, ["--unknown=value"])).toThrow(
      "지원하지 않는 인수입니다: --unknown=value",
    );
  });

  it("rejects a configured store URL without a slug", () => {
    const storeWithoutSlug: StoreConfig = {
      ...stores[0],
      storeBaseUrl: "https://example.com/",
    };

    expect(() => selectStoresFromArgs([storeWithoutSlug], ["--store=store-a"])).toThrow(
      "Store A (store-a) 스토어 URL에서 slug를 찾을 수 없습니다",
    );
  });
});
