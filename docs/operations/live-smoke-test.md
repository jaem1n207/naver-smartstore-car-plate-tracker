# Live Smoke Test

Run this only on a fixed-IP staging or production server.

## Preconditions

- Server public IP is registered separately on both Naver store applications.
- Naver app has product read permissions enabled.
- Google service account can edit the target spreadsheet.
- Exactly one Google credential source is configured. The file-path method is recommended.
- Naver client secrets have been rotated after any exposure.

## Sequence

1. Set `NAVER_API_MODE=live`.
2. Set `ALLOW_LIVE_NAVER_API=true`.
3. Run `pnpm sync:once`.
4. Confirm all eight managed Korean tabs exist and each managed range is a native Google Sheets table.
5. Confirm the first five tabs are the two inventory views, two store-specific plate-duplicate views, and the cross-store plate-duplicate view.
6. Confirm operator tables expose `차량번호`, `중복 상태`, `상품 URL`, `스토어 표시명`, `전시 상태`, `상품 상태`, `상품명`, `최초 감지일시`, `마지막 동기화일시`, `관리자 메모`, `마지막 오류일시`, and `오류 메시지` in that order.
7. Confirm the header has white text on a dark teal background and `차량번호` plus `중복 상태` remain frozen while scrolling horizontally.
8. In both inventory and duplicate tabs, confirm duplicate rows appear before unique rows, equal plate numbers are adjacent, and only the first two cells are duplicate-highlighted.
9. Confirm the exact status labels and colors: `같은 스토어 내 중복` uses background `#FFF3C4`, text `#5B3A00`, and border `#B7791F`; `두 스토어 간 중복` uses `#E8F0FE`, `#174EA6`, and `#3B6FC4`; `같은 스토어 + 두 스토어 중복` uses `#FCE8E6`, `#8A1C1C`, and `#C5221F`. A mixed plate group uses the border priority both, across stores, same store. Normal `ON` and `SALE` cells remain neutral, and exception statuses use readable semantic colors against the surrounding browser theme.
10. Confirm `원본 데이터`, `차량번호 추출 실패`, and `실행 기록` follow the operator tabs.
11. Confirm `차량번호 추출 실패` has image-only or no-text products.
12. Edit `관리자 메모` in `원본 데이터`, rerun once, and confirm the note and `최초 감지일시` are preserved and projected into the matching operator rows. Do not edit the derived operator copy because the next sync rewrites it.
13. Confirm a known asymmetric duplicate case: for a normalized plate with two active listings in one store and one in the other, the two same-store listings appear in that store's internal duplicate tab, the other store's internal duplicate tab has no row for that plate, and all three listings appear in the cross-store duplicate tab. Confirm the two internally duplicated rows retain `같은 스토어 + 두 스토어 중복` in both views.
14. Review logs for `GW.IP_NOT_ALLOWED`, `GW.AUTHN`, `GW.RATE_LIMIT`, and `GW.QUOTA_LIMIT`.

## Sync output verification

The `sync:once` JSON log and scheduler log must expose only the explicit result fields `syncScope`, `selectedStores`, `syncedProductsThisRun`, `sheetTotalProducts`, `sheetExtractionSuccess`, `sheetExtractionFailure`, `sheetDuplicateProductRows`, and `summary`; the old ambiguous keys `totalProducts`, `successCount`, `failureCount`, and `duplicateCount` must be absent. Confirm that `syncedProductsThisRun` describes the requested stores in the current run, while the `sheet*` values describe the whole managed sheet. In particular, `sheetDuplicateProductRows` counts product rows with a non-unique status, not unique plate groups.

A representative successful full-store `sync:once` Pino record is:

```json
{
  "level": 30,
  "time": 1783987200000,
  "pid": 12345,
  "hostname": "car-plate-tracker",
  "syncScope": "all_stores",
  "selectedStores": ["동부트럭 (store-east)", "서부트럭 (store-west)"],
  "syncedProductsThisRun": 5,
  "sheetTotalProducts": 5,
  "sheetExtractionSuccess": 4,
  "sheetExtractionFailure": 1,
  "sheetDuplicateProductRows": 3,
  "summary": "전체 스토어 동기화 완료 | 대상: 동부트럭 (store-east), 서부트럭 (store-west) | 이번 실행 동기화 5개 | 시트 전체 상품 5개 | 시트 전체 차량번호 추출 성공 4개, 실패 1개 | 시트 전체 중복 상태 상품 행 3개",
  "msg": "sync completed"
}
```

Here `sheetDuplicateProductRows: 3` means three product rows have a non-unique duplicate status; it does not mean there are three unique plate groups. Likewise, `sheetExtractionFailure: 1` means one row in the whole managed sheet lacks a successful plate extraction. A `sync completed` or `scheduled sync completed` message means the synchronization job itself completed successfully even when `sheetExtractionFailure` is greater than zero. Job failures use `sync failed` or `scheduled sync failed` instead.

Confirm the `실행 기록` row uses this exact header order: `실행 시작일시`, `실행 종료일시`, `실행 모드`, `실행 범위`, `실행 대상 스토어`, `이번 실행 동기화 상품 수`, `시트 전체 상품 수`, `시트 전체 추출 성공 수`, `시트 전체 추출 실패 수`, `시트 전체 중복 상품 행 수`, `실행 결과`.

For a spreadsheet with the exact legacy header `실행 시작일시`, `실행 종료일시`, `실행 모드`, `전체 상품 수`, `추출 성공 수`, `추출 실패 수`, `중복 상품 수`, `실행 결과`, confirm existing rows migrate to 11 columns with `실행 범위` set to `이전 형식`; `실행 대상 스토어` and `이번 실행 동기화 상품 수` remain blank, and the four legacy totals retain their values in the corresponding whole-sheet columns. Any other non-empty header must stop the run-log write without rewriting the header or appending a row.

If generic Korean or legacy English tabs already exist, confirm they were renamed in place. The previous `스토어 내부 중복` tab should become the first configured store's duplicate tab. Existing manually-created tables should keep their table identity while adopting the managed range and column structure.

## Store-scoped recovery

If only one store application is ready, sync it by using the slug from its configured Smartstore URL:

```bash
pnpm sync:once --store=store-a
```

The worker replaces rows for the selected store and preserves existing rows for every unselected store. It then rebuilds all views and duplicate statuses from the combined data. Do not edit `.env` for a temporary store-scoped run.

After both applications are ready, omit `--store` to return to a full sync:

```bash
pnpm sync:once
```
