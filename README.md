# Signature Aspen · Design File Delivery

An account-free client upload application with an optional Microsoft Entra ID employee workspace, built with Next.js, PostgreSQL, Azure Blob Storage and Resend. Supports multiple PSD, AI, PDF, ZIP and TIFF assets, including individual files larger than 5 GB. The default transfer limit is 20 GiB, with up to 100 files.

The interface uses the supplied [Signature Aspen logo](https://signatureaspen.com/wp-content/uploads/2023/09/logo2.png) with a text fallback and neutral styling. The logo is requested by the browser without a referrer; hosting a licensed copy locally is recommended for production reliability. The upstream image was unavailable to the build environment, so the palette is not represented as a verified official brand palette.

## Run locally

Requires Node.js 22+ (Node 24 recommended), PostgreSQL, an Azure Storage account with a private blob container, and a verified Resend sending domain.

```sh
npm ci
cp .env.example .env.local
# Fill in .env.local, create the PostgreSQL database, then:
npm run db:setup
npm run dev
```

Open http://localhost:3000. Set `APP_URL` to the exact public origin in production (HTTPS required). Generate independent `COOKIE_SECRET` and `CRON_SECRET` values using `openssl rand -hex 32`. Never expose storage, database, email, or cron credentials through `NEXT_PUBLIC_` variables. Production commands: `npm run build` then `npm start`. Run focused tests with `npm test`.

`DATABASE_URL` must use your provider's required TLS configuration and a direct or **session-pooled** connection, not a transaction-pooling endpoint: transfer lifecycle operations use PostgreSQL session advisory locks. The application maintains its own connection pool. Storage credentials and network configuration are described below; employee Microsoft SSO is independent of application-to-storage authentication.

Optional limits are `MAX_TRANSFER_BYTES`, `MAX_TRANSFER_FILES`, `MAX_TRANSFER_RECIPIENTS`, and `DATABASE_POOL_MAX` (see `.env.example`). The form supports up to 100 files and describes the default 20 GiB allowance; adjust its copy if you change the byte limit.

## How it works

1. The sender selects files and enters sender/recipient emails, company, project title, an optional note and passcode, and 7/14/30-day retention.
2. The server validates the manifest and stores metadata and an Azure upload session in PostgreSQL. The browser receives a separate upload capability; a download link cannot modify uploads.
3. The browser sends up to three blocks concurrently directly to Azure using short-lived, blob-scoped SAS URLs, shows aggregate progress/speed, and retries failed blocks. Cancellation settles all in-flight blocks; resume discovers stored blocks. No uploaded file passes through the application server.
4. The server verifies block order and sizes, snapshots the committed staging data, and uses Azure server-side range copies to finalize server-controlled download blobs, then emails the sender, recipients, and configured internal team. Browser-writable staging data is separate from delivered files. The receipt displays the private link with a Copy Link action.
5. Recipients view metadata and download individual signed objects or a streaming ZIP. Protected transfers require a passcode, shared separately by the sender. Expired links stop working immediately, independent of the cleanup schedule.

### Resume and delivery behavior

Pause and resume in the same browser, including after a refresh. Reselect the **same original files in the same order**; the browser checks names, sizes, modification times, and hashes of the first/last 64 KiB. Only the transfer capability and file fingerprints are persisted locally, not file contents or passcodes. Do not use shared/untrusted browsers for sensitive uploads. Clearing browser storage loses the ability to resume or cancel; cleanup still removes abandoned data. Pause stops the current chunk; completed chunks are discovered from storage on resume.

Storage and email are external services. An email failure must not discard a successful transfer; use the receipt link when notifications are delayed. A transfer URL is a bearer secret: share it only with intended recipients. No account or inbox verification is provided.

## Azure Blob Storage setup

Create a **StorageV2** account with a private block-blob container (for example `design-transfers`). Set `AZURE_STORAGE_ACCOUNT_NAME` and `AZURE_STORAGE_CONTAINER`. The application uses the standard HTTPS endpoint `https://<account>.blob.core.windows.net`; it does not use an S3 compatibility layer, arbitrary endpoints, or an emulator connection string.

Disable anonymous blob access and require secure transfer. Container creation is a deployment step, not something anonymous upload requests perform. Choose a region close to your upload audience. Keep enough capacity for cloud data plus temporary staging copies during finalization.

### Azure-hosted application: managed identity

Leave `AZURE_STORAGE_ACCOUNT_KEY` empty. The SDK uses `DefaultAzureCredential`; on Azure, enable a system-assigned managed identity on your App Service or compute resource. For a user-assigned identity, attach it to the host and set `AZURE_CLIENT_ID` to its client ID.

Grant that identity **Storage Blob Data Contributor** at the **storage account scope**. This supplies data access and the account-level permission to obtain a user delegation key used to sign short-lived SAS URLs. An alternative least-scope arrangement is container-scoped data permissions plus **Storage Blob Delegator** at account scope. Allow time for role assignments to propagate. Plain Azure management-plane Contributor is not sufficient.

Managed identity mode does not need storage account keys or a client secret. Keep `AZURE_TENANT_ID`/`AZURE_CLIENT_SECRET` unset unless intentionally configuring service-principal credentials. The application signs user-delegation SAS URLs server-side; it never gives Azure account credentials or delegation keys to browsers.

### Local application and NAS worker: Azure credentials

Use the same account/container as the Azure application and one of:

- **Service principal:** configure `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET`, and assign the same storage roles described above. Protect and rotate the secret. These variables are separate from the `ENTRA_*` employee-login settings.
- **Developer login:** use `az login` on an authorized development machine and leave account key/service-principal variables empty; the logged-in identity needs the same storage data/delegation permissions. Do not depend on an interactive developer login for production services.
- **Account-key fallback:** set `AZURE_STORAGE_ACCOUNT_KEY` on the server only. It takes precedence over the default credential chain and signs service SAS URLs. This grants broader authority than managed identity; prefer an identity in production. If shared-key access is disabled on the account, use managed identity/service principal instead.

Do not commit `.env.local`, embed credentials in browser code, or put any Azure secret in a `NEXT_PUBLIC_` variable.

### Browser CORS and network access

In the storage account's **Blob service CORS** settings, add your exact public frontend origin. Do not use `*` for origins. Allow `PUT`, allow the `content-type` and `x-ms-*` request headers (or all headers if required by your chosen proxy), expose `ETag` and `x-ms-request-id` for diagnostics, and set a suitable preflight cache duration (for example 3600 seconds). Browser success does not depend on an ETag header; block contents and sizes are checked by the server. Add `http://localhost:3000` as a separate development origin only.

Browser uploads/downloads go directly to the Blob endpoint. That endpoint must be reachable from remote clients: a private-endpoint-only account will not work for anonymous internet uploads unless those clients have a route to it or you deploy an upload gateway. Keep containers private even when the storage network endpoint is public; SAS controls access.

The application uses bounded upload-write SAS URLs and read-only download SAS URLs, scoped to one blob and limited by transfer expiry. SAS is a bearer permission: do not log query strings. Azure SAS cannot constrain a client to one block number or prevent it from committing the staging blob; the server validates expected blocks and isolates finalized objects from the staging namespace before exposing downloads.

Large-file finalization performs copies inside Azure rather than downloading and re-uploading through the web server. It may take more than one request: if the UI reports that finalization is still in progress, choose **Resume upload** with the original files still selected. Already uploaded browser blocks and already copied destination blocks are reused where safe; notifications and the shareable link appear only after verification finishes.

### Retention and migration

Keep the authenticated cleanup schedule running. Azure does not use S3 multipart abort: uncommitted blocks age out under Azure's service rules, while committed staging and finalized blobs require application cleanup. Configure a staging-only lifecycle backstop longer than the maximum active upload retention (for example 31 days for the current 30-day maximum), not a blanket one-day rule that would delete a resumable active upload. Verify soft-delete/versioning policies against your retention requirements; deleting a current blob may retain billable versions or recoverable copies.

An issued upload SAS cannot be individually revoked. It may remain usable for at most its short lifetime, never beyond transfer expiry, and can recreate staging data after cancellation. Cleanup must continue sweeping the staging prefix even after transfer file records have been removed. Finalized download blobs are never writable with upload SAS URLs.

This is a **storage replacement, not a data-copy migration**. S3 objects and in-progress S3 uploads are not automatically moved or resumed. For an initial deployment, use a fresh database/container. For an existing deployment, stop new uploads, drain/cancel unfinished transfers with the old application, export any retained assets, and plan a verified object/metadata migration or let old links expire before switching. Keep the old service/storage available for remaining old links until that transition is complete.

Reapply `db/schema.sql` (or run `npm run db:setup`) before starting this version against an existing database. It additively creates `transfer_files.azure_snapshot`, which records the immutable source used for crash-safe finalization retries. This schema update does not convert legacy S3 sessions or copy their objects.

## Deploy the application on Azure or a local server

1. Provision PostgreSQL and the private Blob container. Configure the storage identity, Blob CORS, and network access above.
2. Use a Node.js host supporting long-lived streaming responses (for example Azure App Service or a suitable container host). Deploy the repository with Node 24, install with `npm ci`, and run `npm run build`. Start using `npm start`; the host may supply `PORT`. The same build/start commands work on a local Linux server behind an HTTPS reverse proxy.
3. Set every environment value from `.env.example` in the host's secure application settings. Set production `APP_URL` to its exact HTTPS origin, use PostgreSQL TLS, and generate independent cookie/cron/NAS secrets. Configure Entra's callback URI for that exact origin if employee login is enabled.
4. Apply migrations once against the deployment database with `npm run db:setup` from a controlled deployment machine that has `.env.local`. If using host-provided environment variables instead, execute `db/schema.sql`, `db/employee.sql`, and `db/nas.sql` in that order with your PostgreSQL migration tooling. Do not place a secret-bearing env file in the deployed public directory.
5. Schedule the authenticated cleanup request below, configure sender email, enforce request rate limits, and run the production smoke tests. Run the NAS worker/service on the local host—not inside a cloud host that cannot mount your office share.

If both Azure and local web applications are active, use a single canonical `APP_URL` behind routing/reverse proxies, or deploy separate instances with separately configured origins and Entra redirect URIs. Origins must match exactly for mutation checks. A shared PostgreSQL database and container allow both hosts to see the same transfers; session/cookie secrets and NAS signing configuration must be consistent where sessions are shared. Do not assume browser cookies will be shared between different domains.

## Optional employee workspace (Microsoft Entra ID)

Anonymous client uploads remain available with SSO disabled. When enabled, employees select **Employee sign-in with Microsoft** on the same home page. After sign-in, the page becomes a file library with client/project/filename search, paginated results, cloud downloads, link sharing, NAS status, and a quick-upload tab with email/company prefilled.

1. Create a **single-tenant web application** in your company's Microsoft Entra tenant. Register the exact redirect URI `https://your-upload-host/api/auth/callback` (localhost HTTP is permitted for development).
2. Configure `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` and comma-separated `ENTRA_ALLOWED_GROUP_IDS`. Use group **object IDs**, not group names. Keep client secrets server-side and rotate them before expiration.
3. Configure ID tokens to include security-group IDs (prefer groups assigned to the application), the **`acct` optional claim** (required: `0` for tenant members; guests/missing values are rejected), and the `email` claim for upload prefill. The signed email is display data only; authorization uses the immutable tenant/object ID. If Microsoft omits email, employees enter their address manually.
4. Assign approved employees/groups to the application and enable Entra's assignment requirement. Configure your tenant's MFA/Conditional Access policies as appropriate.
5. Optionally set `ENTRA_ADMIN_GROUP_IDS` to a separate administrator group's object ID. Administrators **must also** satisfy the allowed-group rule. Leave this empty for assigned-only access.
6. Run `npm run db:setup` against the existing database to apply the additive employee and NAS schemas; existing transfer rows are preserved.

The sign-in flow uses authorization code + PKCE, nonce/state validation, and signature/issuer/audience/tenant verification. Group-overage tokens are rejected rather than querying arbitrary Graph endpoints or allowing access by email domain. Configure group claims so the required memberships fit in the ID token. Entra guest accounts flagged as guests are rejected; your directory's application assignments/group membership remain the employee admission boundary.

### Employee permissions

- Ordinary employees see **their own authenticated uploads and explicitly assigned transfers only**, not every client transfer.
- Administrators see all completed, unexpired transfers and can assign a transfer by an employee's Entra object ID in the dashboard. Do not assign by sender/recipient email; those fields are user-supplied.
- The server enforces access independently on listing, share links, cloud downloads, and local-download URL issuance. Employee downloads can access an assigned protected transfer without entering its public-link passcode; public recipients still need that passcode.
- Anonymous uploads are initially unassigned and appear in the administrator library. Employees must belong to the approved group even when an administrator assigns them.
- Sessions are opaque, stored as hashes, HTTP-only, and expire after eight hours. Group claims are rechecked against configured allowlists on requests, but directory membership changes require a new login to refresh. For immediate revocation, remove that employee's rows from `employee_sessions`; sign-out revokes the current session. Protect administrative DB access and avoid long sessions if your policy requires faster directory revocation.
- Public share links remain bearer links, not employee-only links. Sharing does not reveal the passcode, and employee access does not change public-link expiration.

## Optional local NAS delivery

### Topology

```text
Remote clients ──HTTPS blocks────> private Azure Blob container
                                          │
                                  background mirror
                                          ↓
Office employees ──HTTPS LAN/VPN──> Linux NAS service ──> mounted NAS share
Remote employees ──HTTPS─────────> cloud download
```

SSO does not increase network speed. Cloud uploads still depend on each client's internet uplink. Parallel chunks can improve throughput but cannot exceed the network/storage bottleneck. Once mirrored, office employees can read the local copy over the LAN; remote employees continue using cloud downloads.

This implementation targets an **always-on Linux host with `/proc` available**, with a dedicated NAS directory mounted using SMB or NFS. It does not write to a Windows user's mapped drive, and it does not expose SMB publicly. Azure Blob remains canonical. **Direct browser-to-NAS uploads and reverse NAS-to-cloud synchronization are a later phase**, not implemented here.

### Configure and run

1. Mount the share on the Linux host and create a dedicated `NAS_ROOT` owned only by the service account. Use an absolute, canonical path without symlinks; do not point at the whole NAS or another application's directory. The services check `/proc/self/mountinfo` and require an active `cifs`, `smb3`, `nfs`, or `nfs4` mount rather than silently writing into an unmounted local directory. Ensure the mount exists before starting services (for example a service-manager mount dependency). Root device/inode changes fail closed; verify the share and restart both services after remounting. Use mount permissions appropriate for sensitive assets.
2. On the web application, set `NAS_ENABLED=true`, `NAS_LOCAL_URL` to the internal HTTPS service origin, and an independent random `NAS_SIGNING_SECRET` of at least 32 characters. Do not reuse cookie/cron secrets.
3. On the local host, install this application and configure the same PostgreSQL database, Azure Blob source, NAS signing secret, Entra configuration and base application environment. Set `NAS_ROOT`, `NAS_LOCAL_URL`, and `NAS_ENABLED=true`. The mirror uses Azure SDK streamed reads; provide the full documented base environment even though it does not send email.
4. Run `npm run db:setup` once, then supervise `npm run nas:sync` and `npm run nas:serve` as separate services. The worker polls every `NAS_SYNC_INTERVAL_MS` (default 30 seconds). For a single cycle, use `npm run nas:sync -- --once`.
5. The local HTTP listener defaults to `127.0.0.1:8787`. Place an HTTPS reverse proxy on the office host in front of it, with a trusted certificate, internal DNS for `NAS_LOCAL_URL`, and LAN/VPN-only firewall rules. Never port-forward it or publish it as a public NAS gateway. The browser must trust and reach this internal HTTPS origin.
6. Confirm the database uses a direct/session-pooled URL on both hosts. Lifecycle locks serialize mirroring and cleanup; a long mirror can temporarily make conflicting operations return 409.

No extra cron endpoint is needed for mirroring; the worker is the scheduler. Keep the existing cloud cleanup schedule running as well.

### Local availability and security

The library displays **Waiting for NAS**, **Syncing to NAS**, **Available locally**, or **NAS sync failed**. Refresh the library to update status. Once available, each file offers **Local network ↓** in addition to **Cloud**; cloud ZIP downloads remain available everywhere. Local downloads stream individual files with byte-range support rather than buffering large assets.

The web application issues a short-lived, signed local URL only after checking the authenticated employee's transfer permission. The local service checks signature/scope/expiry and rechecks the employee session, assignment, transfer expiration, and mirror availability against the database. It fails closed if the database is unavailable. Network location or forwarded IP headers are not treated as authentication.

Copies use generated identifiers rather than user filenames on disk, size-checked streaming, temporary files, and atomic rename. Linux directory descriptors and no-follow filesystem operations constrain paths. Local directories are **application-managed storage**, not an unrestricted employee SMB browser. Serving and deletion obey application authorization/expiration; do not grant users direct share access that bypasses those checks.

The worker retries failed mirrors and removes expired/cancelled/orphaned local copies on subsequent cycles, including after cloud cleanup deletes file records. Downloads stop being authorized at expiration even when cleanup is delayed. Run and monitor both services continuously; local files cannot be physically deleted while the mount/worker is offline. Prevent snapshots/backups from retaining sensitive content longer than your policy permits.

Do not log signed local download URLs: like cloud signed URLs, they briefly carry download authority. Disable query-string logging at the local reverse proxy.

## Expiration, reminders, and operations

Schedule an authenticated `GET /api/cron/cleanup` request at least hourly. Use an `Authorization` header: the word `Bearer`, a space, then your `CRON_SECRET`. Do not put the secret in a URL. This removes expired/abandoned storage objects and cleans transfer records. Set `ENABLE_EXPIRATION_REMINDERS=true` to enable email warnings for completed transfers expiring within the next 24 hours. The schedule must actually run; configuring the environment variable alone does not schedule cleanup.

Set `INTERNAL_NOTIFICATION_EMAILS` to comma-separated internal addresses and `FROM_EMAIL` to a verified sender. Public email addresses and filenames are untrusted input, not evidence of sender identity. Configure SPF/DKIM/DMARC with your email provider.

### Required production safeguards

- Put rate limits and quotas in front of transfer creation, part signing, passcode attempts, and downloads. Anonymous uploads consume storage and email budget; application validation is **not** abuse prevention. Use a WAF, provider controls, and optionally CAPTCHA at ingress before opening the service publicly.
- Run ZIP downloads on a Node.js host that supports streaming and sufficiently long requests. The ZIP does not buffer whole files, but a 20 GiB download can outlast short serverless request limits. Uploads bypass that limit because they go directly to storage.
- Monitor cron failures, storage costs, email delivery, failed transfers, and database growth. Back up the database and apply your own metadata/access-log retention policy.
- Downloads are served as attachments; extension checks do not prove file safety. This starter does not scan uploaded assets for malware. Add quarantine/scanning if your threat model requires it.
- Passcodes are hashed and unlock cookies are short-lived and HTTP-only. Enforce HTTPS. Already-issued individual download URLs remain usable briefly until their signed expiry; deleting a transfer cannot retract bytes already downloaded.
- Do not log transfer URLs, upload capabilities, passcodes, or signed storage URLs in analytics or reverse-proxy logs. Security headers prevent referrer leakage and framing.

## Layout and API

```text
src/app/                 Upload page, transfer page and API routes (App Router)
src/components/          Upload/progress and transfer preview interfaces
src/lib/                 Validation, access control, storage and email helpers
db/schema.sql            PostgreSQL schema
tests/                   Node.js regression tests
```

| Endpoint | Purpose |
| --- | --- |
| `POST /api/transfers` | Create manifest and Azure block-upload sessions |
| `GET /api/transfers/:id/upload` | Resume using storage's completed parts |
| `POST /api/transfers/:id/parts` | Sign one file part |
| `POST /api/transfers/:id/complete` | Verify and finalize, then notify |
| `DELETE /api/transfers/:id` | Cancel an unfinished upload |
| `GET /api/transfers/:id` | Get available transfer metadata |
| `POST /api/transfers/:id/unlock` | Unlock passcode-protected metadata/downloads |
| `GET /api/transfers/:id/download` | Stream ZIP; `?file=:fileId` for one file |
| `GET /api/cron/cleanup` | Authenticated scheduled cleanup/reminders |
| `GET /api/auth/login`, `GET /api/auth/callback` | Company Microsoft sign-in |
| `GET /api/auth/session`, `POST /api/auth/logout` | Employee session and sign-out |
| `GET /api/employee/transfers` | Server-filtered library with search/pagination |
| `POST /api/employee/transfers/:id/share` | Authorized public share-link retrieval |
| `GET /api/employee/transfers/:id/download` | Authorized cloud file or ZIP download |
| `POST /api/employee/transfers/:id/assign` | Administrator-only employee assignment |
| `POST /api/employee/transfers/:id/local` | Authorized short-lived local file URL |

Upload management endpoints require the separate upload capability in an `Authorization` header: the word `Bearer`, a space, then the capability. Public transfer IDs are generated using cryptographically secure randomness, not sequential database IDs.

## Verification

The repository includes focused validation/security tests and can build without cloud credentials. Before production, run an integration smoke test against an isolated Azure container/database using the deployment's actual identity: upload multiple files including a single file over 10 GB; interrupt/resume; verify downloaded checksums; test protected/expired links; confirm all notification recipients; verify NAS streams; and run cleanup to confirm finalized and staging data are removed. Confirm Blob CORS from a real browser. Browser automation and real cloud delivery require available services and credentials.

The optional PostgreSQL lifecycle test runs with `TEST_DATABASE_URL` set to a **dedicated disposable database**; never use a production/shared database. It exercises real database state and locking while mocking Azure Blob and Resend. Without that variable, `npm test` runs the unit/security tests and skips that integration case.
