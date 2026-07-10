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
8. In both inventory and duplicate tabs, confirm duplicate rows appear before unique rows, equal plate numbers are adjacent with the same background and top/bottom border, and the next plate group uses a different background.
9. Confirm duplicate, display, and product status cells consistently use distinct colors for different codes and remain readable against the surrounding browser theme.
10. Confirm `원본 데이터`, `차량번호 추출 실패`, and `실행 기록` follow the operator tabs.
11. Confirm `차량번호 추출 실패` has image-only or no-text products.
12. Edit `관리자 메모` in `원본 데이터`, rerun once, and confirm the note and `최초 감지일시` are preserved and projected into the matching operator rows. Do not edit the derived operator copy because the next sync rewrites it.
13. Confirm each store-specific duplicate tab and the cross-store duplicate tab match known normalized plate cases.
14. Review logs for `GW.IP_NOT_ALLOWED`, `GW.AUTHN`, `GW.RATE_LIMIT`, and `GW.QUOTA_LIMIT`.

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
