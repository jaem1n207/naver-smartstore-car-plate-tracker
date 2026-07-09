# Oracle Cloud systemd Operation

Use this guide after the server has a fixed public IP and Naver Commerce API has allowed that IP.

## Install

```bash
pnpm install --frozen-lockfile
pnpm build
```

## Environment

Create a server-only `.env` file outside git. Include the variables from `.env.example`.

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
