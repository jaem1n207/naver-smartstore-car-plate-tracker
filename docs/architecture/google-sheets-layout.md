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

Every duplicate plate group keeps its rows adjacent. Only the `차량번호` and `중복 상태` cells are duplicate-highlighted; the rest of each row keeps the neutral table banding except for existing exception-state cells. The exact duplicate labels and low-saturation semantic palette are:

| Domain status              | Korean label                   | Background | Text      | Group border |
| -------------------------- | ------------------------------ | ---------- | --------- | ------------ |
| `duplicated_in_same_store` | `같은 스토어 내 중복`          | `#FFF3C4`  | `#5B3A00` | `#B7791F`    |
| `duplicated_across_stores` | `두 스토어 간 중복`            | `#E8F0FE`  | `#174EA6` | `#3B6FC4`    |
| `duplicated_both`          | `같은 스토어 + 두 스토어 중복` | `#FCE8E6`  | `#8A1C1C` | `#C5221F`    |

Each row uses the fill and text color for its exact status. A mixed-status plate group uses the highest-information border in this order: `duplicated_both`, `duplicated_across_stores`, then `duplicated_in_same_store`. The duplicate-status column is 240 px wide so the Korean labels remain readable. All foreground/background pairs meet WCAG AA contrast of at least 4.5:1.

The header uses white text on dark teal (`#174C3C`) and the first two columns stay frozen during horizontal scrolling. Color is reserved for duplicates and exception states; normal `ON` and `SALE` cells inherit the neutral table background. Exception cells use a small semantic palette:

| Meaning | Codes and color families                                               |
| ------- | ---------------------------------------------------------------------- |
| 중복    | Non-unique statuses use the three exact status-specific palettes above |
| 정보    | `WAIT` uses blue                                                       |
| 주의    | `SUSPENSION`, `OUTOFSTOCK` use amber                                   |
| 차단    | `UNADMISSION`, `REJECTION`, `PROHIBITION` use red                      |
| 비활성  | `CLOSE`, `DELETE`, and unknown non-empty status codes use neutral gray |
| 정상    | `ON`, `SALE`, and `중복 없음` receive no direct fill                   |

Every managed foreground/background pair has at least a 4.5:1 contrast ratio. The fixed cell colors remain legible against light or dark surrounding application chrome. Unknown non-empty status codes use a neutral gray fallback instead of remaining unstyled.

Ordering, duplicate key fills, exception colors, borders, header style, and frozen columns are managed output and are reapplied on every sync. Operators should not rely on manual sorting or formatting in derived tabs.

## Developer Tabs

The final three tabs are:

1. `원본 데이터`: canonical 21-column state used for upsert and manual notes
2. `차량번호 추출 실패`: full diagnostic rows for extraction review
3. `실행 기록`: one row per completed sync

The CLI and scheduler expose the same explicit synchronization result fields. `syncScope` is `all_stores` or `selected_stores`; `selectedStores` contains the display names requested for the run; and `syncedProductsThisRun` counts non-deleted products fetched and written for those stores in the current run. The remaining fields describe the whole managed sheet after the run:

- `sheetTotalProducts`: all preserved and newly synchronized product rows.
- `sheetExtractionSuccess`: rows with successful plate extraction.
- `sheetExtractionFailure`: rows without successful plate extraction.
- `sheetDuplicateProductRows`: product rows whose duplicate status is not unique. This is a count of product rows, not a count of unique vehicle-number or plate groups.
- `summary`: concise Korean text that states current-run scope first and whole-sheet totals second.

The `실행 기록` tab uses these explicit Korean headers, in order:

| Header                      | Meaning                                              |
| --------------------------- | ---------------------------------------------------- |
| `실행 시작일시`             | Run start timestamp                                  |
| `실행 종료일시`             | Run finish timestamp                                 |
| `실행 모드`                 | Mock or live API mode                                |
| `실행 범위`                 | Full-store or selected-store scope                   |
| `실행 대상 스토어`          | Display names requested in this run                  |
| `이번 실행 동기화 상품 수`  | `syncedProductsThisRun`                              |
| `시트 전체 상품 수`         | `sheetTotalProducts`                                 |
| `시트 전체 추출 성공 수`    | `sheetExtractionSuccess`                             |
| `시트 전체 추출 실패 수`    | `sheetExtractionFailure`                             |
| `시트 전체 중복 상품 행 수` | `sheetDuplicateProductRows`, counted as product rows |
| `실행 결과`                 | `summary`                                            |

## Duplicate Semantics

Duplicate identity is the normalized vehicle plate, and each product row receives exactly one status:

- `duplicated_in_same_store`: the plate occurs at least twice in this row's own store and does not occur in the other store.
- `duplicated_across_stores`: the plate occurs in both stores, while this row's own store contains exactly one occurrence.
- `duplicated_both`: the plate occurs in both stores and this row's own store contains at least two occurrences.

The two inventory tabs may contain rows with any of these statuses. Each store-specific duplicate tab currently shows only `duplicated_in_same_store` rows, while the cross-store duplicate tab contains both `duplicated_across_stores` and `duplicated_both` rows. `sheetDuplicateProductRows` deliberately counts every non-unique product row, so two products sharing one plate contribute two rows even though they form one plate group.

## Native Tables And Migration

Every managed range uses the Google Sheets native table feature. During sync:

- A table beginning at A1 is reused by its `tableId` and resized.
- A missing table is created after its headers and rows are written.
- Empty views retain a header plus one blank table row.
- Operator tables use 12 visible columns; stale columns M:U from previous 21-column views are cleared and hidden.
- Obsolete row colors and duplicate borders are cleared before the current sync formatting is applied.
- The former `스토어 내부 중복` tab migrates to the first configured store's internal duplicate tab.
- Unknown tabs are preserved.

The `실행 기록` header migration accepts only an empty sheet, the exact current 11-column header above, or this exact legacy 8-column header:

1. `실행 시작일시`
2. `실행 종료일시`
3. `실행 모드`
4. `전체 상품 수`
5. `추출 성공 수`
6. `추출 실패 수`
7. `중복 상품 수`
8. `실행 결과`

For an exact legacy header, each existing row expands to 11 columns with this mapping before the new run is appended:

| Current column              | Migrated legacy value                    |
| --------------------------- | ---------------------------------------- |
| `실행 시작일시`             | Existing `실행 시작일시`                 |
| `실행 종료일시`             | Existing `실행 종료일시`                 |
| `실행 모드`                 | Existing `실행 모드`                     |
| `실행 범위`                 | Literal `이전 형식`                      |
| `실행 대상 스토어`          | Blank; not inferable from the legacy row |
| `이번 실행 동기화 상품 수`  | Blank; not inferable from the legacy row |
| `시트 전체 상품 수`         | Existing `전체 상품 수`                  |
| `시트 전체 추출 성공 수`    | Existing `추출 성공 수`                  |
| `시트 전체 추출 실패 수`    | Existing `추출 실패 수`                  |
| `시트 전체 중복 상품 행 수` | Existing `중복 상품 수`                  |
| `실행 결과`                 | Existing `실행 결과`                     |

Any unknown non-empty header fails closed before the header is rewritten or a run-log row is appended; an operator must resolve the unsupported header instead of allowing the worker to guess its meaning.

See [Google Sheets Tables API](../references/google-sheets-tables-api.md) for the primary API references used by the repository implementation.
