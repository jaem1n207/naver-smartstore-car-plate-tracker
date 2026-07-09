# Naver Smartstore Car Plate Tracker Design

Date: 2026-07-09

## 1. Requirements Summary

Build a Node.js and TypeScript backend automation that periodically reads registered products from two Naver Smartstore seller accounts, extracts Korean vehicle plate numbers from product detail content, and writes the result to Google Sheets.

The system must not use a browser extension, Naver login ID/password, scraping from a personal PC, or OCR. Naver Commerce API client IDs and secrets are runtime secrets only. Local development uses mocks and fixtures; live Naver API calls are allowed only from a staging or production server whose fixed public IP has been registered with Naver Commerce API.

Registered inventory includes products regardless of sales/display status, including sale completed, out of stock, suspended, pending, rejected, or prohibited states. Products with API status `DELETE` are treated as deleted records and excluded from the default registered-inventory views.

## 2. Feasibility And Core Conditions

The system is feasible with the official Naver Commerce API and Google Sheets API.

Confirmed from official Naver Commerce API docs:

- Product search: `POST https://api.commerce.naver.com/external/v1/products/search`.
- Product detail: `GET https://api.commerce.naver.com/external/v2/products/channel-products/{channelProductNo}`.
- Origin product detail: `GET https://api.commerce.naver.com/external/v2/products/origin-products/{originProductNo}`.
- Detail HTML/text source: `originProduct.detailContent`.
- Token endpoint: `POST https://api.commerce.naver.com/external/v1/oauth2/token`.
- Auth signature: bcrypt hash of `${clientId}_${timestamp}` with `clientSecret` as salt, then base64 encode.
- Naver gateway may return `GW.IP_NOT_ALLOWED`, `GW.AUTHN`, `GW.RATE_LIMIT`, and `GW.QUOTA_LIMIT`.

Still needs confirmation before live integration:

- Exact API group permission name required for product search and product detail read access.
- Whether each store should request token `type=SELF` or `type=SELLER`.
- If `SELLER` is required, the exact `account_id` value for each store.
- Whether each issued application has access to the expected Smartstore channel.
- Whether the target Google Sheet can be shared with a service account.

## 3. Recommended Architecture

Use a Sheets-first worker architecture.

One Node.js process runs a scheduled sync job. Each run loads store config, fetches products from Naver Commerce API, fetches detail content, extracts and normalizes plate numbers, calculates duplicate status across all latest rows, and upserts results into Google Sheets.

Main components:

- `ConfigLoader`: validates environment variables and store definitions.
- `NaverCommerceClient`: token issuance, token cache, product search, product detail.
- `MockNaverCommerceClient`: local fixtures for development and tests.
- `PlateExtractor`: HTML-to-text, candidate extraction, normalization, validation.
- `DuplicateAnalyzer`: same-store and cross-store duplicate classification.
- `SheetRepository`: reads existing rows, upserts raw data, rewrites view sheets, appends run logs.
- `SyncJob`: orchestrates the end-to-end flow.
- `Scheduler`: cron or interval trigger for production.

No database is required for MVP. Google Sheets is the source of operational visibility, and `RawData` acts as the upsert state store.

## 4. Google Sheets Options Comparison

Option A: two sheets for Store A and Store B.

- Pros: simple and familiar.
- Cons: cross-store duplicates and extraction failures require formulas or manual scanning.
- Verdict: too weak for the main duplicate-management goal.

Option B: four to five purpose-specific sheets.

- Pros: non-developers can immediately open the needed view.
- Cons: source rows and derived views can drift unless the automation fully owns every tab.
- Verdict: usable, but less maintainable without a raw source layer.

Option C: RawData plus View sheets.

- Pros: one canonical raw table, many human-friendly views, easy debugging, easier idempotent upsert.
- Cons: one extra raw sheet that non-developers should avoid editing.
- Verdict: recommended.

## 5. Final Google Sheets Structure

Recommended tabs:

- `README`: explains which tabs are automatic, which are for viewing, and how to read statuses.
- `RawData`: canonical row per store and channel product.
- `A_Store_View`: all non-deleted registered products for Store A.
- `B_Store_View`: all non-deleted registered products for Store B.
- `Across_Stores_Duplicates`: normalized plates found in both stores.
- `Same_Store_Duplicates`: normalized plates repeated within one store.
- `Extraction_Failures`: products where plate extraction failed or produced invalid/ambiguous output.
- `RunLog`: one row per sync run with counts and error summary.

The automation writes `RawData`, rewrites derived view tabs, and appends `RunLog`. Humans may add notes only to explicitly preserved columns such as `manualNote`.

## 6. Data Model

Required columns:

- `storeKey`: stable internal key such as `A` or `B`.
- `storeName`: display name from runtime config, not hardcoded in source.
- `channelProductNo`: Naver channel product number.
- `originProductNo`: Naver origin product number, if present.
- `productUrl`: generated from configured store URL and product number.
- `productName`: channel product name or origin product name.
- `productStatus`: Naver product status enum.
- `displayStatus`: channel display status if available.
- `rawPlate`: raw matched plate text before normalization.
- `normalizedPlate`: canonical plate value with spaces and hyphens removed.
- `extractionStatus`: `success`, `not_found`, `invalid_format`, or `ambiguous`.
- `duplicateStatus`: `unique`, `duplicated_in_same_store`, `duplicated_across_stores`, or `duplicated_both`.
- `firstSeenAt`: first time this product appeared in the sheet.
- `lastSyncedAt`: latest successful sync time.
- `lastErrorAt`: latest product-level error time.
- `errorMessage`: sanitized, secret-free error summary.

Optional columns:

- `channelNo`
- `storeUrl`
- `saleStartDate`
- `saleEndDate`
- `detailContentHash`
- `detailTextSnippet`
- `apiTraceId`
- `manualNote`

Do not store full detail HTML in Google Sheets by default. Store a hash and short snippet to reduce accidental exposure of real inventory details.

## 7. Plate Extraction Design

Pipeline:

1. Decode HTML entities and convert detail HTML to text.
2. Normalize unicode with NFKC.
3. Preserve label proximity before removing all spacing.
4. Search label-near candidates first: `차량번호`, `차번`, `등록번호`, `자동차번호`.
5. Fall back to full-body pattern search.
6. Normalize candidates by removing spaces, hyphens, dots, colons, and pipe separators.
7. Validate candidate format.
8. Return one status and optional matched value.

Supported MVP format:

- `2-3 digits + 1 Korean letter + 4 digits`, with optional spaces or hyphens between groups.

Examples handled by tests:

- `123가4567`
- `123 가 4567`
- `123-가-4567`
- HTML table text such as `차량번호 | 123가4567`

If multiple different valid candidates are found, return `ambiguous` and include a sanitized message. If the vehicle number is only present inside an image, return `not_found`. OCR is explicitly out of scope.

## 8. Duplicate Detection Design

Only rows with `extractionStatus=success` and a non-empty `normalizedPlate` participate in duplicate detection.

Algorithm:

1. Group rows by `normalizedPlate`.
2. Within each plate group, group by `storeKey`.
3. If a store group has two or more rows, those rows are same-store duplicates.
4. If the plate appears in both store keys, those rows are cross-store duplicates.
5. If both conditions apply to a row, mark `duplicated_both`.
6. Otherwise mark `unique`.

The system never deletes or modifies Smartstore products. It only reports duplicate status in Google Sheets.

## 9. Naver Commerce API Integration Design

Each store has a `StoreConfig`:

- `storeKey`
- `storeName`
- `storeBaseUrl`
- `clientId`
- `clientSecret`
- `accountId`
- `expectedChannelUrl`

Secrets are read from environment variables or a server secret manager. The source code and committed docs must contain placeholders only.

Token strategy:

- Generate timestamp immediately before token request.
- Generate `client_secret_sign` using bcrypt and base64.
- Request token with `grant_type=client_credentials`.
- Cache token per store until `expires_in - 60 seconds`.
- On `401` with `GW.AUTHN`, refresh token once and retry.

Product sync strategy:

- For each store, call `POST /v1/products/search`.
- Use `page` starting from `1`.
- Use `size` initially `100`, tune up to `500` only after observing latency and rate limit headers.
- Include every non-deleted status by omitting `productStatusTypes` when safe, or by explicitly passing all statuses except `DELETE` if the API requires a filter.
- For each channel product, call channel product detail and read `originProduct.detailContent`.
- Limit concurrency and honor `429` responses with exponential backoff and jitter.

Official docs to reference during implementation:

- Product search: https://apicenter.commerce.naver.com/llms/post-v1-products-search.md
- Channel product detail: https://apicenter.commerce.naver.com/llms/get-v2-products-channel-products-channelProductNo.md
- Origin product detail: https://apicenter.commerce.naver.com/llms/get-v2-products-origin-products-originProductNo.md
- OAuth token: https://apicenter.commerce.naver.com/llms/post-v1-oauth2-token.md
- Auth and signature: https://apicenter.commerce.naver.com/llms/intro-%EC%9D%B8%EC%A6%9D.md
- Rate and quota limits: https://apicenter.commerce.naver.com/llms/intro-%EC%A0%9C%EC%95%BD%EC%82%AC%ED%95%AD.md
- Error troubleshooting: https://apicenter.commerce.naver.com/llms/intro-%EB%AC%B8%EC%A0%9C%ED%95%B4%EA%B2%B0.md

## 10. Google Sheets Integration Design

Use a Google service account for server automation.

Required setup:

- Create a service account.
- Share the target spreadsheet with the service account email.
- Store service account credentials as a protected server secret.
- Configure `GOOGLE_SHEETS_SPREADSHEET_ID` at runtime.

Write behavior:

- Read current `RawData`.
- Build key `storeKey + channelProductNo`.
- Preserve `firstSeenAt` and `manualNote` from existing rows.
- Update sync-derived columns on every run.
- Rewrite derived view sheets from computed current state.
- Append one `RunLog` row per run.

Google Sheets is the human management UI, not the source for Naver API credentials or product mutation.

## 11. Local Development Strategy

Local development defaults to mock mode.

- `NAVER_API_MODE=mock` is the default.
- `NAVER_API_MODE=live` is blocked unless `ALLOW_LIVE_NAVER_API=true`.
- Fixtures cover product search responses, product details, HTML table content, label-near text, no-plate content, and image-only content.
- Google Sheets writer can run against an in-memory mock or an explicitly configured test spreadsheet.

No local process should call live Naver Commerce API from a personal IP.

## 12. Server Test Strategy

Use staging or production VM with fixed public IP.

Smoke test order:

1. Confirm server clock sync with NTP.
2. Register server fixed public IP in Naver Commerce API settings.
3. Issue token for Store A.
4. Issue token for Store B.
5. Call `GET /v1/seller/channels` and verify expected Smartstore channels.
6. Call product search with `size=1`.
7. Fetch one product detail and confirm `originProduct.detailContent` is present.
8. Run extractor in dry-run mode.
9. Write to a test Google Sheet.
10. Switch to the production spreadsheet after review.

## 13. Operations And Deployment Strategy

Recommended deployment:

- Oracle Cloud Free Tier VM.
- Fixed public IP.
- Node.js LTS.
- `systemd` service and timer, or one long-running process with an internal cron scheduler.

Process manager comparison:

- `systemd`: recommended for a small VM; standard logs, restart policy, boot integration.
- `pm2`: convenient for Node.js, but another tool to manage.
- Docker: good reproducibility, but more operational overhead for this MVP.

Run frequency:

- Start with every 5 minutes.
- Reduce to every 1 minute only if rate limit headers and product volume show enough margin.
- Provide a manual `sync:once` command for initial full sync and debugging.

## 14. Environment Variables

Required runtime variables:

- `NODE_ENV`
- `TZ=Asia/Seoul`
- `LOG_LEVEL`
- `NAVER_API_MODE`
- `ALLOW_LIVE_NAVER_API`
- `NAVER_API_BASE_URL`
- `SYNC_CRON`
- `STORE_A_NAME`
- `STORE_A_BASE_URL`
- `STORE_A_CLIENT_ID`
- `STORE_A_CLIENT_SECRET`
- `STORE_A_ACCOUNT_ID`
- `STORE_B_NAME`
- `STORE_B_BASE_URL`
- `STORE_B_CLIENT_ID`
- `STORE_B_CLIENT_SECRET`
- `STORE_B_ACCOUNT_ID`
- `GOOGLE_SHEETS_SPREADSHEET_ID`
- `GOOGLE_APPLICATION_CREDENTIALS` or `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`

Committed `.env.example` must contain variable names only.

## 15. Expected Folder Structure

```text
src/
  config/
  domain/
    duplicates/
    plate/
  naver/
  sheets/
  sync/
  scheduler/
tests/
  fixtures/
    naver/
    product-details/
  unit/
  integration/
docs/
  superpowers/
    specs/
```

## 16. Implementation Order

1. Rotate exposed Naver API secrets before live deployment.
2. Confirm API group permissions and token `account_id` requirements.
3. Scaffold TypeScript project.
4. Add environment validation and redaction utilities.
5. Implement plate normalization and extraction with fixtures.
6. Implement duplicate analyzer.
7. Implement mock Naver client.
8. Implement Google Sheets repository against mock/test sheet.
9. Implement live Naver auth and product clients.
10. Implement sync job orchestration.
11. Add scheduler and `sync:once`.
12. Add staging smoke test script.
13. Deploy to fixed-IP VM.
14. Run live smoke test and review Google Sheets output.

## 17. Test Plan

Unit tests:

- Plate normalization removes spaces, hyphens, and separators.
- Plate extraction handles label-near values.
- Plate extraction handles HTML table text.
- Plate extraction returns `not_found` for image-only content.
- Plate extraction returns `ambiguous` for multiple different valid plates.
- Duplicate analyzer classifies unique, same-store, cross-store, and both.
- Config validation rejects missing secrets in live mode.
- Redaction masks client secrets and credential-like values.

Integration tests:

- Mock end-to-end sync writes expected rows to an in-memory sheet adapter.
- Existing `firstSeenAt` and `manualNote` are preserved on upsert.
- Product-level failures produce sanitized `errorMessage`.
- `401/GW.AUTHN` refreshes token once.
- `429` triggers backoff.

Server smoke tests:

- Token issue for both stores.
- Seller channel verification.
- One-page product search.
- One product detail fetch.
- Dry-run extraction counts.
- Test spreadsheet write.

## 18. Security Checklist

- Rotate any API secret exposed in chat, screenshots, command captures, or local attachments before production use.
- Do not commit actual store names, store URLs, Google Sheet IDs, vehicle numbers, client IDs, client secrets, cookies, or service account JSON.
- Commit `.env.example`; never commit `.env`.
- Add secret scanning before shipping.
- Redact secrets from normal logs and error logs.
- Never store Naver login ID/password.
- Never store browser cookies for Smartstore automation.
- Use server fixed public IP for Naver Commerce API calls.
- Share the Google Sheet only with the minimum required service account.
- Do not log full product detail HTML by default.
- Store only short sanitized snippets for debugging.

## 19. Open Questions Before Implementation

1. What exact API group permission must be enabled for product search and detail read APIs?
2. Should token requests use `SELF` or `SELLER` for the issued applications?
3. If `SELLER` is needed, what exact `account_id` should each store use?
4. Can the target spreadsheet be shared with a Google service account?
5. Should deleted Naver products with status `DELETE` ever be archived into a separate view, or always ignored?
6. How should ambiguous extraction be handled operationally: failure-only view, or manual override column?
7. Is a five-minute sync interval enough for operations, or is one minute required after rate-limit validation?
8. Should a product with no plate stay in `RawData` forever, or disappear if it later becomes deleted?
9. Should view sheet names be Korean for operators, English for code stability, or both with a mapping table?
