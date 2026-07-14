# Naver Smartstore Car Plate Tracker

Node.js and TypeScript worker for syncing registered Naver Smartstore products, extracting vehicle plate numbers from product detail content, detecting duplicates, and writing Google Sheets views.

## Local Development

Local development uses mock Naver data by default.

Use Node.js `22.23.1` and pnpm `11.10.0`, matching `.node-version`, `package.json`, and CI.

**[MacBook]**

```bash
# [MacBook]
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

Production uses a fixed-IP Oracle VM, Node.js `22.23.1`, pnpm `11.10.0`, immutable compiled releases, and the built-in scheduler under hardened systemd. It does not run `tsx` or `pnpm scheduler` in production.

Follow the ordered [automatic production deployment runbook](docs/operations/automatic-production-deployment.md) for backup, moving the existing `/opt` checkout to `/srv/carplate-bootstrap-source`, persistent 2 GiB swap, exact runtime installation, the initial built checkout, dedicated users, secret migration, forced deploy key, GitHub `production` environment, branch protection, first deployment, reboot verification, rollback drill, rotation, and diagnostics. The currently open deployment PR is **#2**.

PR #2 must be merged with **Create a merge commit**, not squash merge or rebase merge. Bootstrap records the PR head as the initial deployed SHA, and the monotonic deployer requires the new `main` revision to be its descendant.

After the one-time privileged bootstrap, merging a verified PR into `main` is the normal deployment. GitHub-hosted runners build and connect directly to Oracle, so the developer's MacBook may be off. Routine `main` deployments do not update root-owned deployment scripts, systemd units, SSH policy, sudoers, or `/etc` secrets; those changes require an explicit reviewed bootstrap-maintenance operation.

systemd keeps the scheduler enabled across VM reboots and runs deployment recovery before startup. It cannot guarantee Oracle power, network, Naver, Google, DNS, credentials, disk space, or successful sync jobs. See the shorter [Oracle systemd operations reference](docs/operations/oracle-cloud-systemd.md) and use the [fixed-IP live smoke test](docs/operations/live-smoke-test.md) for real external verification.

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
Duplicate rows appear before unique rows in every operator table. Rows sharing a normalized plate stay adjacent; only the `차량번호` and `중복 상태` cells use one light amber group fill and border. The remaining row cells keep neutral banding, normal `ON` and `SALE` states stay unfilled, and only exception statuses use stable semantic colors. The first two columns remain frozen and the header uses white text on dark teal.

Developer tabs appear afterward:

6. `원본 데이터`
7. `차량번호 추출 실패`
8. `실행 기록`

The internal `A` and `B` keys remain only in developer data for stable duplicate analysis. Naver's original product and display status codes remain unchanged so operators can compare them directly with the API source.
Operator tabs are derived views and are rewritten on every sync. Enter or edit `관리자 메모` in `원본 데이터`; the next sync projects that canonical value into all matching operator tabs.
Operator ordering and formatting are also managed output. Manual row ordering, colors, or borders in those tabs can be replaced by the next sync.
