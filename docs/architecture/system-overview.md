# System Overview

The worker runs one sync pipeline:

1. Load runtime config and two store configs.
2. Fetch non-deleted registered products from Naver Commerce API.
3. Fetch product detail content for each channel product.
4. Extract and normalize vehicle plate numbers from text content only.
5. Calculate same-store and cross-store duplicate status.
6. Build store display names from configured names and URL slugs, then ensure the eight managed Korean tabs exist.
7. Project decision-first operator tables, upsert developer `원본 데이터`, rewrite views, and append `실행 기록`.

Google Sheets is the operator UI and MVP state store. The first five tabs are operator-facing inventory and plate-duplicate tables; the final three are developer-facing raw data, extraction failures, and run logs. Operator rows begin with normalized plate, duplicate status, product URL, store display name, and display status, then expose product status, product name, timestamps, manual note, and error context. Store tabs and rows use a human-readable `name (slug)` label; `A` and `B` remain internal keys only. Headers, extraction states, duplicate states, and run modes are written in Korean. Naver product and display status codes stay in their original API form. The worker does not mutate Smartstore products.

Each repository instance initializes the sheet structure once. Managed native table names are
stable identities, while configured store display names determine mutable tab titles. A display
name change renames the sheet containing the matching managed table instead of creating a new tab.
Previous `A스토어 매물`, `B스토어 매물`, `스토어 내부 중복`, and legacy English tabs remain
fallback migration candidates. Unknown tabs are preserved. If a desired title and its managed
table belong to different sheets, initialization fails before Naver reads or Sheet value writes.

Every managed range is a native Google Sheets table. Existing top-left tables are reused by `tableId`; missing tables are added; ranges are resized to the current row count. Operator columns use deterministic widths, and obsolete columns from the former 21-column views are cleared and hidden.
