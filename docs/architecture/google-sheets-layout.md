# Google Sheets Layout

Google Sheets serves two audiences: a non-developer operator managing duplicate vehicle listings and a developer diagnosing sync behavior. The layout keeps those concerns separate.

## Operator Tabs

The first five tabs are ordered for repeated inventory work:

1. First store inventory
2. Second store inventory
3. First store internal plate duplicates
4. Second store internal plate duplicates
5. Cross-store plate duplicates

All operator tables use the same 12 columns. The five most frequently checked fields stay at the left, followed by secondary context:

| Order | Header            | Purpose                                                  |
| ----- | ----------------- | -------------------------------------------------------- |
| 1     | 차량번호          | Primary vehicle identity, using the normalized plate     |
| 2     | 중복 상태         | Unique, same-store, cross-store, or both                 |
| 3     | 상품 URL          | Direct path to inspect the Smartstore listing            |
| 4     | 스토어 표시명     | Human-readable configured name and URL slug              |
| 5     | 전시 상태         | Original Naver display status code                       |
| 6     | 상품 상태         | Original Naver product status code                       |
| 7     | 상품명            | Listing title for quick identification                   |
| 8     | 최초 감지일시     | First successful discovery time preserved across syncs   |
| 9     | 마지막 동기화일시 | Most recent successful product sync time                 |
| 10    | 관리자 메모       | Canonical note projected from the developer raw-data tab |
| 11    | 마지막 오류일시   | Most recent recorded product error time                  |
| 12    | 오류 메시지       | Latest sanitized product error context                   |

Internal store keys, product IDs, hashes, and extraction internals remain omitted from operator tabs. Operator tabs are derived views and are rewritten on every sync, so `관리자 메모` must be edited in `원본 데이터`; edits made directly in an operator tab are not authoritative.

## Presentation And Grouping

Operator tables are sorted for duplicate-resolution work:

1. Rows with any duplicate status appear before unique rows.
2. Rows sharing a normalized plate are adjacent.
3. Plate groups are ordered by plate, then store display name and channel product number.
4. Rows without an extracted plate appear last.

Every duplicate plate group receives one shared light background and a matching medium top and bottom border. Four accessible group palettes rotate between neighboring groups, so one plate remains visually connected without blending into the next plate. This grouping applies to both inventory tabs and all duplicate-only tabs.

The header uses white text on dark teal (`#174C3C`) and the first two columns stay frozen during horizontal scrolling. Status cells use stable colors:

| Field     | Codes and color families                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 중복 상태 | `중복 없음` gray, `스토어 내부 중복` yellow, `양쪽 스토어 중복` blue, `내부 및 양쪽 중복` red                                               |
| 전시 상태 | `ON` green, `WAIT` blue, `SUSPENSION` orange                                                                                                |
| 상품 상태 | `SALE` green, `WAIT` blue, `OUTOFSTOCK` amber, `UNADMISSION` violet, `REJECTION` red, `SUSPENSION` orange, `CLOSE` gray, `PROHIBITION` pink |

Every managed foreground/background pair has at least a 4.5:1 contrast ratio. The fixed cell colors remain legible against light or dark surrounding application chrome. Unknown non-empty status codes use a neutral gray fallback instead of remaining unstyled.

Ordering, group fills, status colors, borders, header style, and frozen columns are managed output and are reapplied on every sync. Operators should not rely on manual sorting or formatting in derived tabs.

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
- Operator tables use 12 visible columns; stale columns M:U from previous 21-column views are cleared and hidden.
- Obsolete row colors and duplicate borders are cleared before the current sync formatting is applied.
- The former `스토어 내부 중복` tab migrates to the first configured store's internal duplicate tab.
- Unknown tabs are preserved.

See [Google Sheets Tables API](../references/google-sheets-tables-api.md) for the primary API references used by the repository implementation.
