# Google Service Account Setup

A Google service account is a non-human account for a server program. Its JSON key lets this worker authenticate to Google without storing a personal Google email password or opening an interactive browser session.

The JSON file contains a service account email and a private key. Treat the entire file like a password. Never commit it, paste it into an issue or PR, or print it in logs.

## Create and grant access

1. Create or select a Google Cloud project.
2. Enable the Google Sheets API for that project.
3. Open IAM and Admin, then Service Accounts, and choose Create service account.
4. Open that service account, choose Keys, add a new key, select JSON, and download it once.
5. Open the target spreadsheet, choose Share, and add the JSON file's `client_email` as an Editor.
6. Turn off the notification option. Service accounts do not have an inbox.

Direct sharing is sufficient for one target spreadsheet. Do not grant Google Workspace administrator roles or domain-wide delegation.

### Values for the creation form

Enter these values in the three fields shown in the Google Cloud form:

- Service account name: `네이버 스마트스토어 차량번호 시트 동기화`
- Service account ID: `naver-smartstore-sheet-writer`
- Service account description: `네이버 스마트스토어 매물 차량번호를 Google Sheets에 동기화하는 서버 전용 계정`

The service account ID becomes the local part of the generated email and cannot be changed later. Confirm that the preview resembles `naver-smartstore-sheet-writer@<프로젝트 ID>.iam.gserviceaccount.com`.

Choose Create and done. Leave both optional sections empty:

- Grant this service account access to project: no role selected.
- Principals with access: no user or group added.

These IAM options control Google Cloud project resources, not access to the target spreadsheet. Spreadsheet access is granted later by sharing only that file with the generated service account email.

### Download the JSON key

1. Open the newly created service account from the service account list.
2. Open Keys.
3. Choose Add key, then Create new key.
4. Select JSON and choose Create.
5. Move the downloaded file to the protected server path. The private key cannot be downloaded again.

The downloaded file resembles this structure. These are placeholders, not usable credentials:

```json
{
  "type": "service_account",
  "project_id": "example-project",
  "private_key_id": "REDACTED",
  "private_key": "<비공개 키 전체 내용>",
  "client_email": "sheet-writer@example-project.iam.gserviceaccount.com",
  "client_id": "000000000000000000000"
}
```

## Recommended file configuration

Copy the JSON to a server-only directory outside the repository and restrict it to the process user:

```bash
chmod 600 /etc/naver-smartstore-car-plate-tracker/google-service-account.json
```

Set the absolute path:

```dotenv
GOOGLE_APPLICATION_CREDENTIALS=/etc/naver-smartstore-car-plate-tracker/google-service-account.json
GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=
```

## Secret-manager alternative

When a deployment platform only accepts environment secrets, Base64-encode the complete JSON and configure the alternative variable:

```dotenv
GOOGLE_APPLICATION_CREDENTIALS=
GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=<BASE64로 인코딩한 JSON 전체 문자열>
```

Configure exactly one method. The worker validates the decoded credential as a `service_account` document before passing it to the Google client.

## Complete live `.env` example

All values below are synthetic placeholders. Replace every angle-bracket value on the fixed-IP server only.

```dotenv
NODE_ENV=production
TZ=Asia/Seoul
LOG_LEVEL=info
NAVER_API_MODE=live
ALLOW_LIVE_NAVER_API=true
NAVER_API_BASE_URL=https://api.commerce.naver.com/external
SYNC_CRON=*/5 * * * *

STORE_A_NAME=<첫 번째 스토어 이름>
STORE_A_BASE_URL=https://smartstore.naver.com/<첫 번째 스토어 URL slug>
STORE_A_CLIENT_ID=<첫 번째 스토어 커머스API 애플리케이션 ID>
STORE_A_CLIENT_SECRET=<첫 번째 스토어 커머스API 애플리케이션 Secret>

STORE_B_NAME=<두 번째 스토어 이름>
STORE_B_BASE_URL=https://smartstore.naver.com/<두 번째 스토어 URL slug>
STORE_B_CLIENT_ID=<두 번째 스토어 커머스API 애플리케이션 ID>
STORE_B_CLIENT_SECRET=<두 번째 스토어 커머스API 애플리케이션 Secret>

GOOGLE_SHEETS_SPREADSHEET_ID=<스프레드시트 URL의 d/와 /edit 사이 값>
GOOGLE_APPLICATION_CREDENTIALS=/etc/naver-smartstore-car-plate-tracker/google-service-account.json
GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=
```

For local mock development, copy `.env.example`. Mock mode does not call Naver or Google APIs.

Both Naver applications are `내스토어 애플리케이션`. The worker therefore requests OAuth tokens with `type=SELF`; a seller UID or `STORE_*_ACCOUNT_ID` variable is not required.

The worker combines each configured name and URL slug into the Sheets display label. For example, `동부트럭` plus `example-store-east` appears as `동부트럭 (example-store-east)`.

`STORE_A_NAME` and `STORE_B_NAME` are mutable display configuration, not store identity. Before
changing either value in the protected production environment, deploy a release that supports
stable managed-table migration. The next successful full sync must rename the affected inventory,
internal-duplicate, and cross-store tabs in place while preserving their sheet and table IDs. Do
not delete old tabs or copy rows manually.

## Key incident response

If the JSON is committed, pasted into chat, or otherwise exposed, disable or delete that key in Google Cloud immediately, create a replacement, update the server secret, and rerun the smoke test.

## References

- https://developers.google.com/workspace/guides/create-credentials
- https://docs.cloud.google.com/iam/docs/keys-create-delete
- https://docs.cloud.google.com/docs/authentication/application-default-credentials
