# Google Sheets Tables API

Verified: 2026-07-11

Primary references:

- [Tables guide](https://developers.google.com/workspace/sheets/api/guides/tables)
- [Spreadsheet request reference](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request)
- [Cell and format reference](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/cells)
- [Batch update guide](https://developers.google.com/workspace/sheets/api/guides/batchupdate)

The worker relies on the documented `addTable` and `updateTable` requests. Existing managed tables are updated by `tableId`; missing tables are added after values are written; table ranges are resized to match the managed row and column projection.

Managed presentation uses `updateCells` for current row and status formats, `repeatCell` to clear stale formats and style headers, `updateBorders` to connect duplicate plate groups, and `updateDimensionProperties` for header height and operator column widths. These requests are sent through `spreadsheets.batchUpdate` after values are written.
