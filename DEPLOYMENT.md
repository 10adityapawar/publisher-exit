# Docker deployment preparation

This package is prepared for a single-server private pilot. Hosting and a domain have not been chosen, no resources have been purchased, and nothing is deployed online. The existing local data is not uploaded or included in the image. Keep real customer archives local until the remote-access and isolation review is complete.

## What is included

- A Node.js 24 image that runs all 14 tests during its build, then runs as the non-root node user.
- A persistent `app_data` volume for SQLite and uploaded/exported files. Run exactly one app replica.
- Mounted password/worker-token secrets; the startup script refuses insecure origins or weak secrets.
- Caddy as the only published service, with HTTPS, persistent certificate storage, and an internal app network. No host port exposes the app directly.
- Read-only application filesystem, dropped Linux capabilities, bounded logs, memory limit, and graceful shutdown.
- A process/HTTP healthcheck. This is not a full database or storage-health monitor.

## Prepare without purchasing anything

1. Keep these changes on staging until reviewed. Install Docker Engine with Compose v2 on the eventual Linux server (or Docker Desktop for a local build check).
2. Run `node prepare-deployment.mjs` with Node.js 24. It creates strong random secret files and does not overwrite existing ones. The directory is private on Unix; the individual files remain readable inside the non-root container. On Windows, keep the repository in your private user folder. Never commit the secrets or display them in build logs.
3. Copy `deployment.env.example` to `deployment.env`. Set DOMAIN to the actual hostname without a URL scheme, path, or trailing slash. Do not start the proxy with the example hostname.
4. Test the container build with `docker compose --env-file deployment.env build`. This runs the integration and startup tests. `docker compose --env-file deployment.env config --quiet` validates Compose configuration without printing secrets.

Docker is unavailable in the development session, so an actual image build, Compose startup, Linux volume ownership, and certificate issuance have **not** been verified yet. The 14 Node tests pass outside Docker; Compose configuration has been inspected but still needs validation with Docker Compose. Base-image tags receive updates: choose reviewed immutable digests before a customer launch.

## Before bringing the pilot online

Choose a host with durable storage, configure DNS for DOMAIN, and allow ports 80/443 to Caddy. Put a private access layer with MFA in front of the pilot or integrate managed authentication before admitting real customer data. Plan Windows worker connectivity through that layer; a browser-only access gate will otherwise block the worker. Do not expose the Docker socket or app port.

Complete the upload scanning/isolation, disk-capacity limits, monitoring, retention/deletion, and backup/restore checks before real customer use. Caddy's request limit only bounds individual requests; it does not set total storage quotas. The worker still requires licensed Publisher on a dedicated Windows workstation and manual supervision. Docker does not contain Publisher.

After the hosting configuration is reviewed, run:

```sh
docker compose --env-file deployment.env up -d --build
docker compose --env-file deployment.env ps
docker compose --env-file deployment.env logs --tail=100 app proxy
```

Visit `https://YOUR_DOMAIN`, confirm a valid certificate and HTTPS redirect, and sign in using the password from your private `deployment-secrets/operator-password.txt`. The file initializes a new database only; changing it does not reset an existing account password. Customer invitations must use this same HTTPS origin. Test sign-in, invitation isolation, upload, worker export, PDF download, and restart persistence using practice files.

Copy only the worker token through a secure channel to your Windows workstation, then run:

```powershell
.\Run-PublisherWorker.ps1 -ServerUrl 'https://YOUR_DOMAIN' -TokenFile 'C:\private\publisher-worker-token.txt'
```

Never use a browser invitation token as the worker token. Stop the local worker before switching its destination, and confirm that its queue belongs to the intended environment.

## Backups, upgrades, and rollback

The image is disposable; `app_data` is not. Do not run `docker compose down -v` against data you need. Stop the supervised worker and app before a simple file-copy backup, then copy the entire data directory (including any SQLite WAL files):

```sh
docker compose --env-file deployment.env stop app
mkdir -p backups
docker compose --env-file deployment.env cp app:/var/lib/publisher-exit ./backups/data-snapshot
docker compose --env-file deployment.env start app
```

Use a fresh dated destination for every backup. Also preserve the secrets and deployment configuration privately and keep an encrypted off-server copy. Restore into a separate test volume, ensure the node user can write it, and check database integrity, source hashes, sign-in, and downloads before relying on the backup. A copied folder alone is not a verified restore.

Before upgrading, save the running image ID/digest, take a backup, and review any database changes. Rebuild from the reviewed production commit, restart, and repeat the pilot smoke test. If rollback is needed, stop writes and restore the previous image and compatible verified data snapshot together. Avoid restarting an older image against an incompatible new database.

## References

- [Docker Compose services](https://docs.docker.com/reference/compose-file/services/)
- [Docker Compose secrets](https://docs.docker.com/reference/compose-file/secrets/)
- [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https)
- [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
