# Live Smoke Test

Run this only on a fixed-IP staging or production server.

## Preconditions

- Server public IP is registered in Naver Commerce API settings.
- Naver app has product read permissions enabled.
- Store account IDs are confirmed.
- Google service account can edit the target spreadsheet.
- Exactly one Google credential source is configured. The file-path method is recommended.
- Naver client secrets have been rotated after any exposure.

## Sequence

1. Set `NAVER_API_MODE=live`.
2. Set `ALLOW_LIVE_NAVER_API=true`.
3. Run `pnpm sync:once`.
4. Confirm all seven Korean tabs were created automatically, the two store tabs use configured `name (slug)` labels, and their first rows are frozen.
5. Confirm `원본 데이터` receives rows with Korean headers.
6. Confirm `차량번호 추출 실패` has image-only or no-text products.
7. Confirm the configured two-store common tab and `스토어 내부 중복` match known cases.
8. Edit `관리자 메모`, rerun once, and confirm the note and `최초 감지일시` are preserved.
9. Confirm `실행 기록` contains a Korean header and one result row.
10. Review logs for `GW.IP_NOT_ALLOWED`, `GW.AUTHN`, `GW.RATE_LIMIT`, and `GW.QUOTA_LIMIT`.

If generic Korean or legacy English tabs already exist, confirm they were renamed in place. If both a legacy and configured version existed before the run, the worker preserves both and writes only to the configured tab.
