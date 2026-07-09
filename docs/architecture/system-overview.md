# System Overview

The worker runs one sync pipeline:

1. Load runtime config and two store configs.
2. Fetch non-deleted registered products from Naver Commerce API.
3. Fetch product detail content for each channel product.
4. Extract and normalize vehicle plate numbers from text content only.
5. Calculate same-store and cross-store duplicate status.
6. Ensure the seven Korean operator tabs exist, renaming a legacy English tab in place when safe.
7. Upsert `원본 데이터`, rewrite view tabs, and append `실행 기록`.

Google Sheets is the operator UI and MVP state store. Headers, extraction states, duplicate states, and run modes are written in Korean. Naver product and display status codes stay in their original API form. The worker does not mutate Smartstore products.

Each repository instance initializes the sheet structure once. Existing unknown tabs are preserved, and a legacy English tab is left untouched if the corresponding Korean tab already exists. This avoids deleting operator-managed data.
