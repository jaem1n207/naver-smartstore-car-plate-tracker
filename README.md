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

The worker creates missing tabs automatically, freezes the first row, and writes Korean headers and status labels. Existing legacy English tabs are renamed in place when the Korean tab does not already exist.

- `원본 데이터`
- `A스토어 매물`
- `B스토어 매물`
- `양쪽 스토어 중복`
- `스토어 내부 중복`
- `차량번호 추출 실패`
- `실행 기록`

Naver's original product and display status codes remain unchanged so operators can compare them directly with the API source.
