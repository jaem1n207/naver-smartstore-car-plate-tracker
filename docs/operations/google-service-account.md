# Google Service Account Setup

A Google service account is a non-human account for a server program. Its JSON key lets this worker authenticate to Google without storing a personal Google email password or opening an interactive browser session.

The JSON file contains a service account email and a private key. Treat the entire file like a password. Never commit it, paste it into an issue or PR, or print it in logs.

## Create and grant access

1. Create or select a Google Cloud project.
2. Enable the Google Sheets API for that project.
3. Open IAM and Admin, then Service Accounts, and create a dedicated account for this worker.
4. Open that service account, choose Keys, add a new key, select JSON, and download it once.
5. Open the target spreadsheet, choose Share, and add the JSON file's `client_email` as an Editor.
6. Turn off the notification option. Service accounts do not have an inbox.

Direct sharing is sufficient for one target spreadsheet. Do not grant Google Workspace administrator roles or domain-wide delegation.

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
chmod 600 /opt/naver-smartstore-car-plate-tracker/secrets/google-service-account.json
```

Set the absolute path:

```dotenv
GOOGLE_APPLICATION_CREDENTIALS=/opt/naver-smartstore-car-plate-tracker/secrets/google-service-account.json
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

STORE_A_NAME=<A스토어 이름>
STORE_A_BASE_URL=https://smartstore.naver.com/<A스토어 URL 이름>
STORE_A_CLIENT_ID=<A스토어 커머스API 애플리케이션 ID>
STORE_A_CLIENT_SECRET=<A스토어 커머스API 애플리케이션 Secret>
STORE_A_ACCOUNT_ID=<A스토어 API account ID>

STORE_B_NAME=<B스토어 이름>
STORE_B_BASE_URL=https://smartstore.naver.com/<B스토어 URL 이름>
STORE_B_CLIENT_ID=<B스토어 커머스API 애플리케이션 ID>
STORE_B_CLIENT_SECRET=<B스토어 커머스API 애플리케이션 Secret>
STORE_B_ACCOUNT_ID=<B스토어 API account ID>

GOOGLE_SHEETS_SPREADSHEET_ID=<스프레드시트 URL의 d/와 /edit 사이 값>
GOOGLE_APPLICATION_CREDENTIALS=/opt/naver-smartstore-car-plate-tracker/secrets/google-service-account.json
GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=
```

For local mock development, copy `.env.example`. Mock mode does not call Naver or Google APIs.

## Key incident response

If the JSON is committed, pasted into chat, or otherwise exposed, disable or delete that key in Google Cloud immediately, create a replacement, update the server secret, and rerun the smoke test.

## References

- https://developers.google.com/workspace/guides/create-credentials
- https://docs.cloud.google.com/iam/docs/keys-create-delete
- https://docs.cloud.google.com/docs/authentication/application-default-credentials
