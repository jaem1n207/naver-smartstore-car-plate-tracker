# Google Sheets Layout

Google Sheets serves two audiences: a non-developer operator managing duplicate vehicle listings and a developer diagnosing sync behavior. The layout keeps those concerns separate.

## Operator Tabs

The first five tabs are ordered for repeated inventory work:

1. First store inventory
2. Second store inventory
3. First store internal plate duplicates
4. Second store internal plate duplicates
5. Cross-store plate duplicates

All operator tables use the same five columns:

| Order | Header        | Purpose                                              |
| ----- | ------------- | ---------------------------------------------------- |
| 1     | 차량번호      | Primary vehicle identity, using the normalized plate |
| 2     | 중복 상태     | Unique, same-store, cross-store, or both             |
| 3     | 상품 URL      | Direct path to inspect the Smartstore listing        |
| 4     | 스토어 표시명 | Human-readable configured name and URL slug          |
| 5     | 전시 상태     | Original Naver display status code                   |

Internal store keys, product IDs, hashes, timestamps, extraction internals, and error details are intentionally omitted from operator tabs.

## Developer Tabs

The final three tabs are:

1. `원본 데이터`: canonical 21-column state used for upsert and manual notes
2. `차량번호 추출 실패`: full diagnostic rows for extraction review
3. `실행 기록`: one row per completed sync

## Duplicate Semantics

Duplicate identity is the normalized vehicle plate. The three duplicate categories are mutually exclusive: first-store-only internal duplicates, second-store-only internal duplicates, and any plate appearing in both stores. Rows with `duplicated_both` status appear only in the cross-store table.

## Native Tables And Migration

Every managed range uses the Google Sheets native table feature. During sync:

- A table beginning at A1 is reused by its `tableId` and resized.
- A missing table is created after its headers and rows are written.
- Empty views retain a header plus one blank table row.
- Operator tables use five visible columns; stale columns from previous 21-column views are cleared and hidden.
- The former `스토어 내부 중복` tab migrates to the first configured store's internal duplicate tab.
- Unknown tabs are preserved.

See [Google Sheets Tables API](../references/google-sheets-tables-api.md) for the primary API references used by the repository implementation.
