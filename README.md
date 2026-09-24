# Publisher Exit

A working local service-operations MVP for rescuing Microsoft Publisher libraries. It includes an operator workspace and a project-scoped customer portal.

## Run on Windows

Requires Node.js 24 or newer. There are no npm dependencies or build steps.

```powershell
./Start-App.ps1
```

On first startup, choose an operator password of at least 12 characters. Open **http://127.0.0.1:4317**. Subsequent launches use the stored password hash. The launcher discovers Node on PATH or the bundled Codex runtime. Stop with Ctrl+C.

For other platforms or custom configuration:

```sh
OPERATOR_PASSWORD='choose-a-long-private-password' WORKER_TOKEN='choose-a-separate-random-secret' node server.mjs
```

`OPERATOR_PASSWORD` is only used when creating a new database. It does not reset an existing password. `DATA_DIR` defaults to `./data`; `PORT` defaults to 4317; `HOST` defaults to 127.0.0.1. Never commit credentials or the data directory.

## Working service workflow

1. Create a project and record its contact, referral and publication deadline.
2. Upload Publisher files or an entire source folder. Relative names and SHA-256 hashes are retained. Identical copies in the same project share one conversion; distinct files with the same name are preserved separately.
3. Record payment externally and mark the complete source library received. The $199 audit is a manual service; payment processing is not built into this MVP.
4. Offer a versioned fixed quote with explicit file/page limits, editable template count, revision allowance, delivery date, training and exception terms.
5. Issue a customer invitation. A link is single-use, expires after seven days, and opens an eight-hour project-scoped session. Creating another invitation revokes previous customer sessions. Share invitations manually; the app does not send email.
6. The customer accepts the current quote. Earlier offers become superseded; accepted scope is locked.
7. Run the supervised Publisher worker. Inspect every exported PDF, then mark it reviewed or document an exception.
8. Rebuild editable templates in the customer's chosen tool. Record HTTPS links, ownership, print checks and notes. Customers approve a specific version or request changes.
9. Record the staff member's training and independent editing exercise. The customer accepts the final handoff, including any documented exceptions.
10. Download the PDF ZIP and manifest; keep them in customer-owned storage. Later template-care requests are tracked separately.

Customer links using localhost work only on the same computer. For local testing, open them in a separate browser session so customer sign-in does not replace the operator session. Production remote access requires a deliberately configured HTTPS deployment.

## Supervised Publisher export

On a workstation with a properly licensed, usable Microsoft Publisher installation:

```powershell
./Run-PublisherWorker.ps1
```

Start-App creates a private worker token at `data/worker-token.txt`. For another workstation, securely transfer the token and pass `-ServerUrl https://your-approved-host -TokenFile C:/private/token.txt`.

The runner opens copied sources read-only, forces macros disabled, and exports ordinary PDF through Publisher COM. A separate child process runs each export; the supervisor maintains job leases and stops on a timeout or failure. It does not kill arbitrary Publisher processes. An operator must inspect and close a stuck isolated Publisher instance before restarting. The queue recovers expired leases, stops automatic recovery after three attempts, and supports explicit operator retries.

**Real Publisher conversion has not been validated in the build environment.** Validate representative real documents on a licensed workstation before selling delivery dates. Fonts, linked assets, print settings, old versions, dialogs and damaged files still require inspection. The server checks PDF envelope markers and reported source-page count; it does not prove rendering fidelity, accessibility, or PDF/A compliance. Human QA is required. No PDF/A guarantee is made.

API references: [Open read-only](https://learn.microsoft.com/en-us/office/vba/api/publisher.application.open), [macro security](https://learn.microsoft.com/en-us/office/vba/api/publisher.application.automationsecurity), [PDF export](https://learn.microsoft.com/en-us/office/vba/api/publisher.document.exportasfixedformat).

## Verification

```sh
node --test server.test.mjs
node --check server.mjs
node --check app.js
```

The integration suite uses temporary databases, simulated source files, and a test worker. It exercises authentication, CSRF, project isolation, duplicates, lease expiry, retries, version-specific approvals, immutable accepted scope, delivery gates, ZIP integrity, care, and invitation revocation. It does not run Publisher or verify a real Canva/Affinity template.

## Architecture and limits

- Node's built-in HTTP server and SQLite: one application process, one operator, no external service credentials needed.
- Responsive HTML/CSS/JavaScript UI with no third-party runtime assets.
- Passwords use salted scrypt; sessions are server-side and HttpOnly/SameSite; writes require CSRF tokens.
- File storage is outside the static asset allowlist. File downloads require project authorization. Customer uploads are limited to 800 sources per project and 50 MB per file. PDF outputs are limited to 100 MB. ZIP downloads are capped at 2 GB.
- ZIPs use source IDs for filenames; the manifest maps IDs to original names and records every exception.
- No payments, email delivery, background outreach, automated template design, operator MFA, malware scanning, or PDF/A certification. Provider integrations and production hardening are follow-up work, not simulated successes.
- SQLite replaces the proposed PostgreSQL/object-store architecture for this local pilot. Scale out only after paid pilots validate the workflow.
- Before external deployment, add managed authentication/MFA, backups with a restore drill, malware scanning/isolation, explicit retention/deletion procedures, upload and storage quotas, TLS, monitoring, and provider-specific tests. Binding off-loopback is rejected unless HTTPS APP_ORIGIN and SECURE_COOKIES=true are configured; those settings alone do not implement TLS or make a production deployment secure.

## Backups and customer data

For this local pilot, stop the application and runner before backing up the **entire data directory**, including the database and files. Keep the backup in private storage and test restoring it to a separate DATA_DIR. Retention and deletion are operator-managed; agree them with each customer. Preserve immutable originals in customer-owned storage. Never upload customer data, worker tokens or databases to GitHub.

## Development workflow

`production` is the default/release branch. Develop on `staging`, maintain the draft staging-to-production PR, and merge only on the owner's instruction. No deployment automation is configured. See AGENTS.md and build-plan.md for the standing workflow and product plan.
