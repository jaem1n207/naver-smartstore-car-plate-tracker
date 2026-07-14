# Security

## Trust boundaries

- Naver application credentials authenticate one store each and are read only from runtime environment variables.
- Google service account credentials authenticate the worker and must have Editor access only to the target spreadsheet.
- Product detail HTML is untrusted input. It is parsed as text and is never executed.
- Google Sheets is both the operator UI and persisted sync state. Only the `관리자 메모` field is treated as operator-owned data during upsert.

## Credential handling

- Prefer `GOOGLE_APPLICATION_CREDENTIALS` with a mode `0600` JSON file outside the repository.
- `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` is an alternative for a secret manager, not a second simultaneous credential.
- Base64 is encoding, not encryption. Protect the encoded value exactly like the original JSON.
- The worker validates Base64 JSON as a service-account credential and never logs the decoded value.
- `.env`, service-account JSON, Naver secrets, real store data, and spreadsheet exports are ignored and must not be committed.

## Sheet mutation policy

- Missing managed tabs are created automatically.
- A legacy English managed tab is renamed only when its Korean replacement does not exist.
- Unknown tabs are never deleted or renamed.
- When both legacy and Korean tabs exist, both are preserved and only the Korean tab is managed.
- Writes are limited to columns A through U for product data and A through H for run logs.

## Incident response

Rotate a Naver client secret or delete and replace a Google service-account key after any suspected exposure. Verify the replacement with the fixed-IP live smoke test before restoring the scheduler.
