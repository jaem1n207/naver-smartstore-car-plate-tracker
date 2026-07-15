# Maintainer Workstation Recovery And Handoff

Use this guide when handing the project to another maintainer, replacing the MacBook, or recovering after the maintainer workstation is lost. It complements the canonical [automatic production deployment runbook](automatic-production-deployment.md); it does not replace the server bootstrap, credential rotation, or incident procedures there.

## Current migration checkpoint

This is a dated operator checkpoint, not a live health status. Update it after the first `main` deployment and the remaining production drills.

As of 2026-07-15:

- Oracle bootstrap is complete and the compiled scheduler is enabled and active.
- The live scheduler uses `0 * * * *` and a full two-store synchronization completed successfully with zero extraction failures.
- The GitHub environment is named `production`, permits only `main`, and contains exactly `OCI_DEPLOY_HOST`, `OCI_DEPLOY_USER`, `OCI_DEPLOY_SSH_PRIVATE_KEY`, and `OCI_DEPLOY_KNOWN_HOSTS`.
- PR #2 verification passed. PR #2 still requires **Create a merge commit**; squash or rebase merge is invalid for this one-time migration.
- The documented `main` branch protection rules still require confirmation before merge.
- The first push-to-`main` deployment, reboot verification, and rollback/crash-recovery drill remain to be recorded after merge.

No real host, spreadsheet ID, client credential, private key, or service-account content belongs in this checkpoint.

## Authoritative state map

| Location                                                                                             | Authoritative state                                                             | Workstation replacement rule                                                                              |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| GitHub repository                                                                                    | Source, tests, workflows, runbooks, PR history                                  | Clone again and authenticate the new workstation.                                                         |
| GitHub `production` environment                                                                      | Four deployment secret values and the `main` deployment restriction             | Do not recreate merely because the old Mac is gone. Secret values are not part of the repository handoff. |
| Oracle `/etc/naver-smartstore-car-plate-tracker/`                                                    | Runtime `.env` values and Google service-account JSON                           | Keep on Oracle. Never copy to the new Mac for routine operation.                                          |
| Oracle `/var/lib/naver-smartstore-car-plate-tracker/` and `/opt/naver-smartstore-car-plate-tracker/` | Durable deployment state, sync lock, immutable releases, and `current`          | Inspect through the personal maintenance account only when needed.                                        |
| Google Cloud and the target Sheet                                                                    | Service-account lifecycle and spreadsheet sharing                               | Record non-secret project and account identifiers in an encrypted off-repository inventory.               |
| Naver Commerce API Center                                                                            | Store applications, client-secret lifecycle, permissions, and allowed server IP | Keep credentials out of GitHub and the workstation repository.                                            |
| Maintainer workstation                                                                               | Personal GitHub authentication and a personal Oracle maintenance key            | Replace or restore these independently from the GitHub Actions deploy key.                                |

The GitHub Actions deploy key and the personal Oracle maintenance key are different identities. The deploy key is forced to one server-side deployment command and cannot provide an interactive shell. Losing a local copy of the deploy private key after it was saved in GitHub is expected and does not require rotation by itself.

## Off-repository continuity record

Keep the following non-secret inventory in an encrypted password manager or equivalent protected record. A repository document must contain labels and recovery policy, never the real values.

- GitHub repository URL and the maintainers who can administer Actions environments.
- OCI tenancy, region, compartment, instance name, reserved public IP, and personal maintenance username.
- The approved OCI account-recovery or console-connection owner.
- Target spreadsheet URL, Google Cloud project ID, and service-account email.
- The owner of each Naver store application and where its IP allowlist is administered.
- Credential rotation dates and the person responsible for each rotation.
- The location of the encrypted personal maintenance-key backup, if policy permits one.

At least one OCI administrator path must remain independent of the Mac being replaced. A single private key stored only on one laptop is not a recovery plan.

## Planned Mac replacement

Complete these steps while the old maintenance login still works.

1. Install Git, GitHub CLI, and an SSH client on the new Mac. Clone the repository over HTTPS or configure a new personal GitHub SSH key using GitHub's official SSH guidance.
2. Create a new passphrase-protected personal Oracle maintenance key on the new Mac. Do not reuse `carplate-github-deploy` and do not use the GitHub environment deploy key.
3. From the old trusted session, append only the new public key to the Oracle maintenance account's `authorized_keys`.
4. Test the new key from a second terminal before changing or deleting the old key.
5. Verify the Oracle host fingerprint through the OCI Console or the existing trusted session before accepting a new `known_hosts` entry.
6. Remove the old maintenance public key from Oracle only after the new login, `sudo`, systemd status, and application journal access have been verified.
7. Confirm GitHub Actions and the hourly scheduler without changing any production secret.

Generate a new personal maintenance key. The command prompts for a passphrase; keep it in the encrypted continuity record.

**[New MacBook]**

```bash
ssh-keygen -t ed25519 -a 100 -f "$HOME/.ssh/oci-car-plate-tracker-maintenance" -C "oci-car-plate-tracker-maintenance"
```

Copy only its public half to Oracle using the old trusted maintenance identity.

**[Old MacBook]**

```bash
scp -i "<old-maintenance-private-key>" "$HOME/.ssh/oci-car-plate-tracker-maintenance.pub" "<maintenance-user>@<reserved-public-ip>:/tmp/new-maintenance-key.pub"
```

Install the public key without printing any private material.

**[Oracle]**

```bash
sudo install -d -m 0700 -o "$USER" -g "$USER" "$HOME/.ssh" && sudo touch "$HOME/.ssh/authorized_keys" && sudo chown "$USER:$USER" "$HOME/.ssh/authorized_keys" && sudo chmod 0600 "$HOME/.ssh/authorized_keys" && sudo tee -a "$HOME/.ssh/authorized_keys" </tmp/new-maintenance-key.pub >/dev/null && rm -f /tmp/new-maintenance-key.pub
```

Test from the new Mac before revoking the old public key.

**[New MacBook]**

```bash
ssh -i "$HOME/.ssh/oci-car-plate-tracker-maintenance" -o IdentitiesOnly=yes "<maintenance-user>@<reserved-public-ip>" 'whoami && hostname && sudo systemctl is-active car-plate-tracker.service'
```

Review `authorized_keys` carefully and remove only the exact retired personal key. Do not use a broad search-and-delete command, and do not alter the root-owned `carplate-deploy` authorized-key path.

## Unexpected Mac loss

1. Confirm that the Oracle VM, recent GitHub deployment, and latest Sheet execution record are healthy. Production scheduling does not depend on the lost Mac.
2. Revoke the lost Mac's GitHub authentication, personal access tokens, and personal SSH keys as appropriate.
3. Restore the personal Oracle maintenance key from the approved encrypted backup, or use an independent OCI administrator path to establish a new maintenance public key.
4. When normal SSH is unavailable, use OCI's instance console connection recovery path. Treat it as break-glass access, verify console host fingerprints, and remove temporary console access afterward.
5. Remove the lost personal maintenance public key from Oracle after replacement access works.
6. Rotate Naver, Google, or GitHub deployment credentials only when those credentials may have been exposed. A missing local GitHub deploy-key file alone is not exposure.

Do not overwrite the GitHub `OCI_DEPLOY_SSH_PRIVATE_KEY` with a newly generated key unless its matching public key has first been installed through the reviewed rotation procedure in [Rotate the deploy key or privileged installation](automatic-production-deployment.md#16-rotate-the-deploy-key-or-privileged-installation). Otherwise every production deployment will lose SSH authorization.

Oracle documents instance console connections as a troubleshooting mechanism for recovering an unresponsive or inaccessible Compute instance. Follow the current official procedure rather than relying on a copied console command:

- https://docs.oracle.com/en-us/iaas/Content/Compute/References/serialconsole.htm
- https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/troubleshooting-ssh-connection.htm

## New-workstation verification

Routine source and deployment checks do not require production credentials on the Mac.

**[New MacBook]**

```bash
git clone https://github.com/jaem1n207/naver-smartstore-car-plate-tracker.git && cd naver-smartstore-car-plate-tracker && corepack enable && pnpm install --frozen-lockfile && pnpm test:deployment
```

**[GitHub UI]**

- Confirm **Settings > Environments > production** still allows only `main` and lists exactly four `OCI_DEPLOY_*` secret names.
- Confirm the latest **Production Deployment** workflow result. GitHub does not display the secret values back to maintainers.
- Use **Actions > Production Deployment > Run workflow** on `main` only when a retry is required. Do not start a manual run while a push deployment is active.

**[Oracle, optional maintenance verification]**

```bash
sudo systemctl show car-plate-tracker.service --property=LoadState,ActiveState,SubState,UnitFileState,MainPID,NRestarts,ExecMainStatus,InvocationID && sudo journalctl -u car-plate-tracker.service -n 100 --no-pager --output=cat
```

The scheduler startup record must show `scheduler started`, `mode: live`, `cron: 0 * * * *`, and an `appRevision` matching the active release. A healthy process is not enough by itself; confirm a recent `scheduled sync completed` record and the latest `실행 기록` row in Google Sheets.

## Related procedures

- [Automatic production deployment runbook](automatic-production-deployment.md)
- [Oracle systemd operations](oracle-cloud-systemd.md)
- [Google service-account setup and rotation](google-service-account.md)
- [Fixed-IP live smoke test](live-smoke-test.md)
- [Security boundaries and incident response](../SECURITY.md)
- [GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
- [GitHub SSH authentication](https://docs.github.com/en/authentication/connecting-to-github-with-ssh)
