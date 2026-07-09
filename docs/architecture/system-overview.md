# System Overview

The worker runs one sync pipeline:

1. Load runtime config and two store configs.
2. Fetch non-deleted registered products from Naver Commerce API.
3. Fetch product detail content for each channel product.
4. Extract and normalize vehicle plate numbers from text content only.
5. Calculate same-store and cross-store duplicate status.
6. Upsert `RawData`, rewrite view tabs, and append `RunLog`.

Google Sheets is the operator UI and MVP state store. The worker does not mutate Smartstore products.
