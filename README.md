# Signature Aspen · Design File Delivery

An account-free client upload application with an optional Microsoft Entra ID employee workspace, built with Next.js, PostgreSQL, S3-compatible storage and Resend. Supports multiple PSD, AI, PDF, ZIP and TIFF assets, including individual files larger than 5 GB. The default transfer limit is 20 GiB, with up to 100 files.

The interface uses the supplied [Signature Aspen logo](https://signatureaspen.com/wp-content/uploads/2023/09/logo2.png) with a text fallback and neutral styling. The logo is requested by the browser without a referrer; hosting a licensed copy locally is recommended for production reliability. The upstream image was unavailable to the build environment, so the palette is not represented as a verified official brand palette.

## Run locally

Requires Node.js 22+ (Node 24 recommended), PostgreSQL, a private S3-compatible bucket, and a verified Resend sending domain.

```sh
npm ci
cp .env.example .env.local
# Fill in .env.local, create the PostgreSQL database, then:
npm run db:setup
npm run dev
```

Open http://localhost:3000. Set `APP_URL` to the exact public origin in production (HTTPS required). Generate independent `COOKIE_SECRET` and `CRON_SECRET` values using `openssl rand -hex 32`. Never expose storage, database, email, or cron credentials through `NEXT_PUBLIC_` variables. Production commands: `npm run build` then `npm start`. Run focused tests with `npm test`.

`DATABASE_URL` must use your provider's required TLS configuration and a direct or **session-pooled** connection, not a transaction-pooling endpoint: transfer lifecycle operations use PostgreSQL session advisory locks. The application maintains its own connection pool. `AWS_*` credentials can be omitted when the server uses an IAM role. For R2, configure `S3_ENDPOINT`, the appropriate region (`auto`), and bucket credentials. Keep S3 public access blocked; no public bucket policy is required.

Optional limits are `MAX_TRANSFER_BYTES`, `MAX_TRANSFER_FILES`, `MAX_TRANSFER_RECIPIENTS`, and `DATABASE_POOL_MAX` (see `.env.example`). The form supports up to 100 files and describes the default 20 GiB allowance; adjust its copy if you change the byte limit.

## How it works

1. The sender selects files and enters sender/recipient emails, company, project title, an optional note and passcode, and 7/14/30-day retention.
2. The server validates the manifest, stores metadata in PostgreSQL, and creates multipart uploads. The browser receives a separate upload capability; a download link cannot modify uploads.
3. The browser sends up to three chunks concurrently directly to storage using short-lived signed URLs, shows aggregate progress/speed, and retries failed chunks. Cancellation settles all in-flight chunks; a resumed upload discovers completed parts from storage. No uploaded file passes through the application server.
4. The server lists and verifies uploaded parts and object sizes, completes the transfer, then emails the sender, recipients, and configured internal team. The receipt displays the private link with a Copy Link action.
5. Recipients view metadata and download individual signed objects or a streaming ZIP. Protected transfers require a passcode, shared separately by the sender. Expired links stop working immediately, independent of the cleanup schedule.

### Resume and delivery behavior

Pause and resume in the same browser, including after a refresh. Reselect the **same original files in the same order**; the browser checks names, sizes, modification times, and hashes of the first/last 64 KiB. Only the transfer capability and file fingerprints are persisted locally, not file contents or passcodes. Do not use shared/untrusted browsers for sensitive uploads. Clearing browser storage loses the ability to resume or cancel; cleanup still removes abandoned data. Pause stops the current chunk; completed chunks are discovered from storage on resume.

Storage and email are external services. An email failure must not discard a successful transfer; use the receipt link when notifications are delayed. A transfer URL is a bearer secret: share it only with intended recipients. No account or inbox verification is provided.

## Storage setup

Allow the application role to perform `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:AbortMultipartUpload` and `s3:ListMultipartUploadParts` for the bucket's objects. Also grant `s3:ListBucket` on the **bucket ARN** (not the object ARN): completion recovery checks for an existing object with `HeadObject`, and S3 requires this permission to return 404 rather than 403 for a missing object. S3 multipart create/complete/signing operations use these permissions. Enable encryption at rest and TLS-only access at the bucket/provider level.

Configure bucket CORS with your **exact** frontend origin (not a wildcard):

```json
[
  {
    "AllowedOrigins": ["https://uploads.example.com"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

For the S3 console, use the array above; the AWS API/CLI expects it inside a `CORSRules` property. Add `http://localhost:3000` only for development. Exposing `ETag` is required for browser upload verification.

Configure a bucket lifecycle rule to abort incomplete multipart uploads after a suitable interval (for example 7 days), as a backstop for failed requests. If bucket versioning is enabled, also configure noncurrent-version expiration: ordinary object deletion does not remove previous versions.

## Optional employee workspace (Microsoft Entra ID)

Anonymous client uploads remain available with SSO disabled. When enabled, employees select **Employee sign-in with Microsoft** on the same home page. After sign-in, the page becomes a file library with client/project/filename search, paginated results, cloud downloads, link sharing, NAS status, and a quick-upload tab with email/company prefilled.

1. Create a **single-tenant web application** in your company's Microsoft Entra tenant. Register the exact redirect URI `https://your-upload-host/api/auth/callback` (localhost HTTP is permitted for development).
2. Configure `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` and comma-separated `ENTRA_ALLOWED_GROUP_IDS`. Use group **object IDs**, not group names. Keep client secrets server-side and rotate them before expiration.
3. Configure ID tokens to include security-group IDs (prefer groups assigned to the application) and the `email` claim for upload prefill. The signed email is display data only; authorization uses the immutable tenant/object ID. If Microsoft omits email, employees enter their address manually.
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
Remote clients ──HTTPS multipart──> private cloud bucket
                                          │
                                  background mirror
                                          ↓
Office employees ──HTTPS LAN/VPN──> Linux NAS service ──> mounted NAS share
Remote employees ──HTTPS─────────> cloud download
```

SSO does not increase network speed. Cloud uploads still depend on each client's internet uplink. Parallel chunks can improve throughput but cannot exceed the network/storage bottleneck. Once mirrored, office employees can read the local copy over the LAN; remote employees continue using cloud downloads.

This implementation targets an **always-on Linux host with `/proc` available**, with a dedicated NAS directory mounted using SMB or NFS. It does not write to a Windows user's mapped drive, and it does not expose SMB publicly. The cloud bucket remains canonical. **Direct browser-to-NAS uploads and reverse NAS-to-cloud synchronization are a later phase**, not implemented here.

### Configure and run

1. Mount the share on the Linux host and create a dedicated `NAS_ROOT` owned only by the service account. Use an absolute, canonical path without symlinks; do not point at the whole NAS or another application's directory. Ensure the mount exists before starting services (for example a service-manager mount dependency), and fail service startup when it is absent. Use mount permissions appropriate for sensitive assets.
2. On the web application, set `NAS_ENABLED=true`, `NAS_LOCAL_URL` to the internal HTTPS service origin, and an independent random `NAS_SIGNING_SECRET` of at least 32 characters. Do not reuse cookie/cron secrets.
3. On the local host, install this application and configure the same PostgreSQL database, S3 source, NAS signing secret, Entra configuration and base application environment. Set `NAS_ROOT`, `NAS_LOCAL_URL`, and `NAS_ENABLED=true`. The mirror uses the existing storage configuration; provide the full documented base environment even though it does not send email.
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
| `POST /api/transfers` | Create manifest and multipart uploads |
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

The repository includes focused validation/security tests and can build without cloud credentials. Before production, run an integration smoke test against an isolated bucket/database: upload multiple files including a file over 5 GB; interrupt/resume; verify downloaded checksums; test protected/expired links; confirm all notification recipients; and run cleanup to confirm both objects and abandoned multipart uploads are removed. Browser automation and real cloud delivery require available services and credentials.

The optional PostgreSQL lifecycle test runs with `TEST_DATABASE_URL` set to a **dedicated disposable database**; never use a production/shared database. It exercises real database state and locking while mocking S3 and Resend. Without that variable, `npm test` runs the unit/security tests and skips that integration case.
