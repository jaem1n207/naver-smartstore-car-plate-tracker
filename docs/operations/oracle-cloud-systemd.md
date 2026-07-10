# Oracle Cloud systemd Operation

Use this guide after the server has a fixed public IP and Naver Commerce API has allowed that IP.

## Install

```bash
pnpm install --frozen-lockfile
pnpm build
```

## Environment

Create a server-only `.env` file outside git. Include the variables from `.env.example`. Store the Google service account JSON outside the repository and set `GOOGLE_APPLICATION_CREDENTIALS` to its absolute path.

```bash
sudo install -d -m 700 -o carplate -g carplate /etc/naver-smartstore-car-plate-tracker
sudo chmod 600 /etc/naver-smartstore-car-plate-tracker/google-service-account.json
sudo chown carplate:carplate /etc/naver-smartstore-car-plate-tracker/google-service-account.json
```

Do not set `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` when the file-path variable is configured.

## Service

Create `/etc/systemd/system/car-plate-tracker.service`:

```ini
[Unit]
Description=Naver Smartstore Car Plate Tracker
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/naver-smartstore-car-plate-tracker
EnvironmentFile=/opt/naver-smartstore-car-plate-tracker/.env
ExecStart=/usr/bin/pnpm scheduler
Restart=always
RestartSec=10
User=carplate
Group=carplate

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable car-plate-tracker
sudo systemctl start car-plate-tracker
sudo journalctl -u car-plate-tracker -f
```
