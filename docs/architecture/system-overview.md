# System Overview

The worker runs one sync pipeline:

1. Load runtime config and two store configs.
2. Fetch non-deleted registered products from Naver Commerce API.
3. Fetch product detail content for each channel product.
4. Extract and normalize vehicle plate numbers from text content only.
5. Calculate same-store and cross-store duplicate status.
6. Build store display names from configured names and URL slugs, then ensure the seven Korean operator tabs exist.
7. Upsert `원본 데이터`, rewrite view tabs, and append `실행 기록`.

Google Sheets is the operator UI and MVP state store. Store tabs and rows use a human-readable `name (slug)` label; `A` and `B` remain internal keys only. Headers, extraction states, duplicate states, and run modes are written in Korean. Naver product and display status codes stay in their original API form. The worker does not mutate Smartstore products.

Each repository instance initializes the sheet structure once. Previous `A스토어 매물` and `B스토어 매물` tabs, as well as legacy English tabs, are migration candidates. Existing unknown tabs are preserved, and a legacy tab is left untouched if the configured replacement already exists. This avoids deleting operator-managed data.
