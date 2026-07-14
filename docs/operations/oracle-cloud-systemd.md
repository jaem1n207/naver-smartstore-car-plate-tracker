# Oracle Cloud systemd Operation

Use this guide after the server has a fixed public IP and Naver Commerce API has allowed that IP.

## Install

```bash
pnpm install --frozen-lockfile
pnpm build
```

The production build compiles `src/` only through `tsconfig.build.json` and caps the TypeScript V8 heap at 768 MB. Keep the documented 2 GB swap active on a 1 GB Free Tier VM while building. Full source and test type checking remains available through `pnpm typecheck` on development and CI machines.

## Environment

Create a server-only `.env` file outside git. Include the variables from `.env.example`. Store the Google service account JSON outside the repository and set `GOOGLE_APPLICATION_CREDENTIALS` to its absolute path.

Start production with an hourly full sync:

```dotenv
NODE_ENV=production
SYNC_CRON=0 * * * *
```

The worker currently reads every non-deleted product detail on each run. For stores with hundreds of products, a full run can take tens of minutes under Naver rate limits. Do not use the five-minute example schedule in production until the worker supports incremental sync.

```bash
sudo install -d -m 700 -o carplate -g carplate /etc/naver-smartstore-car-plate-tracker
sudo chmod 600 /etc/naver-smartstore-car-plate-tracker/google-service-account.json
sudo chown carplate:carplate /etc/naver-smartstore-car-plate-tracker/google-service-account.json
```

Do not set `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` when the file-path variable is configured.

## Service definition

Resolve the exact `pnpm` path available to the service account:

```bash
sudo -u carplate -H sh -lc 'command -v pnpm'
```

Use that exact absolute path for `ExecStart` below. The example assumes `/usr/bin/pnpm`.

Create `/etc/systemd/system/car-plate-tracker.service`:

```ini
[Unit]
Description=Naver Smartstore Car Plate Tracker
Wants=network-online.target
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

Deploying the application files and activating the scheduler are separate server steps. First complete the code deployment and production build above, then create or update the unit definition. Updating the repository or `.env` does not automatically reload systemd, and reloading systemd does not deploy application code.

After the unit file is created or changed, activate the scheduler explicitly:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now car-plate-tracker
sudo systemctl status car-plate-tracker --no-pager
sudo journalctl -u car-plate-tracker -f
```

The expected startup log contains `scheduler started`, the configured cron expression, and `mode: live`. `systemctl enable` starts the scheduler automatically after a server reboot.

For a later code-only deployment, stop the existing scheduler before replacing the application, install dependencies, and build. Then start the already-defined service again. For a unit or environment change, run `daemon-reload` and explicitly restart or enable the service as appropriate; do not treat a successful build as scheduler activation.

```bash
sudo systemctl stop car-plate-tracker
# Deploy the new repository contents, then run pnpm install --frozen-lockfile and pnpm build.
sudo systemctl start car-plate-tracker
sudo systemctl status car-plate-tracker --no-pager
```

## Manual Maintenance

The scheduler prevents overlap only inside its own process. Stop the service before a manual `sync:once` so a separate process cannot write the same spreadsheet concurrently:

```bash
sudo systemctl stop car-plate-tracker
sudo -u carplate -H pnpm sync:once
sudo systemctl start car-plate-tracker
```

Use `sudo journalctl -u car-plate-tracker -n 100 --no-pager` to review recent automatic runs. A completed scheduled job logs `scheduled sync completed` with `sheetExtractionFailure`, the number of rows across the whole managed sheet without successful plate extraction. A nonzero `sheetExtractionFailure` is a row-level extraction result, not a scheduler failure; the completion message means the job itself succeeded. An actual job failure logs `scheduled sync failed` instead.
