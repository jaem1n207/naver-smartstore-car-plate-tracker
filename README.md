# Naver Smartstore Car Plate Tracker

Node.js and TypeScript worker for syncing registered Naver Smartstore products, extracting vehicle plate numbers from product detail content, detecting duplicates, and writing Google Sheets views.

## Local Development

Local development uses mock Naver data by default.

Use Node.js 22.13 or newer.

```bash
corepack enable
pnpm install
pnpm test
pnpm sync:once
```

## Live API Guard

Live Naver Commerce API calls require both:

- `NAVER_API_MODE=live`
- `ALLOW_LIVE_NAVER_API=true`

Live mode is intended for a staging or production server with a fixed public IP registered in Naver Commerce API settings.

## Runtime Secrets

Copy `.env.example` to `.env` locally for mock development. Do not commit `.env`, Google service account JSON, Naver client secrets, browser cookies, or product data exports.

For live operation, configure Google authentication with exactly one of these methods:

- `GOOGLE_APPLICATION_CREDENTIALS`: recommended absolute path to a protected JSON key file.
- `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`: Base64-encoded JSON supplied by a secret manager.

See [Google service account setup](docs/operations/google-service-account.md) for creation, Sheet sharing, and the complete environment example.

## Server Operation

Use a fixed public IP server for live Naver Commerce API calls.

Recommended first deployment:

- Oracle Cloud Free Tier VM
- Node.js 22.13 or newer
- systemd service and timer, or the built-in scheduler process
- Google service account shared with the target spreadsheet

## Product Status Policy

All registered non-deleted products are included regardless of sale or display status. Naver products with status `DELETE` are excluded from default views.

## Google Sheets Tabs

The worker creates missing tabs automatically, moves operator tabs before developer tabs, freezes headers, and maintains each managed range as a native Google Sheets table. Existing tables are reused and resized rather than duplicated.

Operator tabs appear first:

1. `<첫 번째 스토어 표시명> 매물`
2. `<두 번째 스토어 표시명> 매물`
3. `<첫 번째 스토어 표시명> 내부 차량번호 중복`
4. `<두 번째 스토어 표시명> 내부 차량번호 중복`
5. `<두 스토어 표시명> 차량번호 중복`

Each operator table exposes the following decision-first columns in order: `차량번호`, `중복 상태`, `상품 URL`, `스토어 표시명`, `전시 상태`, `상품 상태`, `상품명`, `최초 감지일시`, `마지막 동기화일시`, `관리자 메모`, `마지막 오류일시`, and `오류 메시지`. Duplicate views are calculated from normalized vehicle plate numbers.
The three duplicate views are mutually exclusive: each store-specific tab contains duplicates found only inside that store, while the cross-store tab contains every plate present in both stores.
Duplicate rows appear before unique rows in every operator table. Rows sharing a normalized plate stay adjacent and use the same high-contrast group fill and border; neighboring duplicate groups rotate colors. The first two columns remain frozen, the header uses white text on dark teal, and duplicate, display, and product status cells use stable code-specific colors.

Developer tabs appear afterward:

6. `원본 데이터`
7. `차량번호 추출 실패`
8. `실행 기록`

The internal `A` and `B` keys remain only in developer data for stable duplicate analysis. Naver's original product and display status codes remain unchanged so operators can compare them directly with the API source.
Operator tabs are derived views and are rewritten on every sync. Enter or edit `관리자 메모` in `원본 데이터`; the next sync projects that canonical value into all matching operator tabs.
Operator ordering and formatting are also managed output. Manual row ordering, colors, or borders in those tabs can be replaced by the next sync.
