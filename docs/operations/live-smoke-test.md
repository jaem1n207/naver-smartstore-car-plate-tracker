# Live Smoke Test

Run this only on a fixed-IP staging or production server.

## Preconditions

- Server public IP is registered in Naver Commerce API settings.
- Naver app has product read permissions enabled.
- Store account IDs are confirmed.
- Google service account can edit the target spreadsheet.
- Naver client secrets have been rotated after any exposure.

## Sequence

1. Set `NAVER_API_MODE=live`.
2. Set `ALLOW_LIVE_NAVER_API=true`.
3. Run `pnpm sync:once`.
4. Confirm `RawData` receives rows.
5. Confirm `Extraction_Failures` has image-only or no-text products.
6. Confirm duplicate views match known test cases.
7. Review logs for `GW.IP_NOT_ALLOWED`, `GW.AUTHN`, `GW.RATE_LIMIT`, and `GW.QUOTA_LIMIT`.
