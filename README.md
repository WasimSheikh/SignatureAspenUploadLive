# Design Delivery

An account-free large design-file sharing application built with Next.js, PostgreSQL, S3-compatible storage and Resend. Supports multiple PSD, AI, PDF, ZIP and TIFF assets, including individual files larger than 5 GB. The default transfer limit is 20 GiB, with up to 100 files.

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
3. The browser sends chunks directly to storage using short-lived signed URLs, shows progress/speed, and retries failed chunks. No uploaded file passes through the application server.
4. The server lists and verifies uploaded parts and object sizes, completes the transfer, then emails the sender, recipients, and configured internal team. The receipt displays the private link with a Copy Link action.
5. Recipients view metadata and download individual signed objects or a streaming ZIP. Protected transfers require a passcode, shared separately by the sender. Expired links stop working immediately, independent of the cleanup schedule.

### Resume and delivery behavior

Pause and resume in the same browser, including after a refresh. Reselect the **same original files in the same order**; the browser checks names, sizes, modification times, and hashes of the first/last 64 KiB. Only the transfer capability and file fingerprints are persisted locally, not file contents or passcodes. Do not use shared/untrusted browsers for sensitive uploads. Clearing browser storage loses the ability to resume or cancel; cleanup still removes abandoned data. Pause stops the current chunk; completed chunks are discovered from storage on resume.

Storage and email are external services. An email failure must not discard a successful transfer; use the receipt link when notifications are delayed. A transfer URL is a bearer secret: share it only with intended recipients. No account or inbox verification is provided.

## Storage setup

Allow the application role to perform `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:AbortMultipartUpload` and `s3:ListMultipartUploadParts` for the bucket's objects. S3 multipart create/complete/signing operations use these permissions. Enable encryption at rest and TLS-only access at the bucket/provider level.

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

Upload management endpoints require the separate upload capability in an `Authorization` header: the word `Bearer`, a space, then the capability. Public transfer IDs are generated using cryptographically secure randomness, not sequential database IDs.

## Verification

The repository includes focused validation/security tests and can build without cloud credentials. Before production, run an integration smoke test against an isolated bucket/database: upload multiple files including a file over 5 GB; interrupt/resume; verify downloaded checksums; test protected/expired links; confirm all notification recipients; and run cleanup to confirm both objects and abandoned multipart uploads are removed. Browser automation and real cloud delivery require available services and credentials.

The optional PostgreSQL lifecycle test runs with `TEST_DATABASE_URL` set to a **dedicated disposable database**; never use a production/shared database. It exercises real database state and locking while mocking S3 and Resend. Without that variable, `npm test` runs the unit/security tests and skips that integration case.
