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

The worker writes:

- `RawData`
- `A_Store_View`
- `B_Store_View`
- `Across_Stores_Duplicates`
- `Same_Store_Duplicates`
- `Extraction_Failures`
- `RunLog`
