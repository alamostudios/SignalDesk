# Signal Desk

A self-hosted radio incident intake and human-review system for configured P25 talkgroups. It accepts Rdio Scanner's multipart upload API and SDRTrunk's Broadcastify Calls upload handshake; PostgreSQL stores incidents and approvals, Redis/BullMQ runs audio processing and publication, and the React dashboard is served by Nginx.

## Start with Docker

1. Install Docker Desktop with Compose support.
2. Copy `.env.example` to `.env` with `Copy-Item .env.example .env`. Set a strong `POSTGRES_PASSWORD`, separate random `JWT_SECRET`, `INGEST_API_KEY`, and `PUBLIC_AUDIO_SECRET` values of at least 32 characters, `BOOTSTRAP_ADMIN_EMAIL`, and a unique `BOOTSTRAP_ADMIN_PASSWORD` of at least 16 characters. Generate each secret in PowerShell with `$r=[Security.Cryptography.RandomNumberGenerator]::Create();$b=New-Object byte[] 32;$r.GetBytes($b);[BitConverter]::ToString($b).Replace('-','').ToLowerInvariant()`; run it separately for each key. Keep `.env` private.
3. Set `PUBLIC_BASE_URL` to the externally reachable HTTPS origin that Facebook and listeners can reach, and configure `WHISPER_BASE_URL` for an OpenAI-compatible local Whisper endpoint reachable from the containers. The example public URL is intentionally not publishable; production startup refuses a missing Whisper endpoint.
4. Start the stack with `docker compose up --build -d`.
5. Pull the configured Ollama model once: `docker compose exec ollama ollama pull qwen2.5:7b`. Set `AI_MODEL` to match if you choose another model.
6. Open `http://localhost:8080`, sign in as the bootstrap administrator, and add only the talkgroups and location images that may be reviewed.

If a password contains URL-reserved characters, URL-encode it in `DATABASE_URL`.

## Start on Windows Without Docker

Node.js 22+ is required (Node 24 works). Install PostgreSQL 16 from the [Windows installer](https://www.postgresql.org/download/windows/), Redis 7 using [Memurai](https://www.memurai.com/get-memurai) or WSL, and FFmpeg from a Windows build such as [gyan.dev](https://www.gyan.dev/ffmpeg/builds/). Start the PostgreSQL and Redis services first. In PostgreSQL, create a database and login, for example `rdio`/`rdio`; use a strong local password in `DATABASE_URL`.

Then create the repo-root environment file:

```powershell
Copy-Item .env.example .env
```

Edit `.env` for local services: set `NODE_ENV=development`, `DATABASE_URL=postgres://rdio:<password>@localhost:5432/rdio`, `REDIS_URL=redis://localhost:6379`, `STORAGE_DIR=./storage`, `CORS_ORIGIN=http://localhost:5173`, a 32+ character `JWT_SECRET`, `BOOTSTRAP_ADMIN_EMAIL`, and a 16+ character `BOOTSTRAP_ADMIN_PASSWORD`. Also set `INGEST_API_KEY` and `PUBLIC_AUDIO_SECRET`. For SDRTrunk on another machine, set `PUBLIC_BASE_URL` to this PC's reachable LAN URL, such as `http://192.168.1.20:3000`; allow inbound TCP 3000 in Windows Firewall. Configure `WHISPER_BASE_URL` and `AI_BASE_URL` to your local provider URLs.

From the project folder, run (the full npm.cmd path works even when Node is installed but omitted from PATH):

```powershell
& 'C:\Program Files\nodejs\npm.cmd' install
& 'C:\Program Files\nodejs\npm.cmd' run db:migrate
& 'C:\Program Files\nodejs\npm.cmd' run dev
```

The dashboard is at `http://localhost:5173`; the API/SDRTrunk receiver is at port `3000`. `npm run dev` starts the API, background worker, and Vite UI. PostgreSQL, Redis, and FFmpeg must already be running/available. If PowerShell blocks `npm.ps1`, use `npm.cmd` for those commands.

## Connect SDRTrunk and Rdio Scanner

This app is the receiver. SDRTrunk/Rdio Scanner run separately and send calls to Signal Desk; neither application is installed or bundled here. In **Configuration**, add/enable the talkgroups first, then create a receiver key with the scanner's numeric system ID and allowed talkgroups. The generated key is shown once; copy it before closing the reveal.

For SDRTrunk, add a **Broadcastify Calls** streaming configuration. Set its `System ID` to the same system ID used when creating the Signal Desk key, `API Key` to the generated key, and `Broadcastify URL` to `http://<signal-desk-host>:3000/api/broadcastify/call-upload` (or the HTTPS reverse-proxy URL). The test request returns `Ok`. Calls use SDRTrunk's two-step protocol: Signal Desk returns a short-lived audio URL, then SDRTrunk PUTs the MP3 to it. The host in `PUBLIC_BASE_URL` must be reachable from the SDRTrunk machine.

Rdio Scanner-compatible recorders can POST directly to `/api/call-upload` as `multipart/form-data` with an `audio` file and the `key`, `system`, `talkgroup`, and `timestamp` (or `dateTime`) fields. Optional standard fields such as `audioName`, `audioType`, `frequency`, `source`, `site`, `patches`, and `frequencies` are retained as internal metadata. The response is `Call imported successfully.`

Everything outside configured, enabled talkgroups is rejected. Keys are stored as hashes, restricted to their system/talkgroup scope, and can be revoked by an Admin. A generic normalized JSON adapter remains available at `POST /api/ingest` using the separate `INGEST_API_KEY` environment secret:

```json
{
  "externalId": "scanner-call-id",
  "talkgroupId": "1234",
  "eventType": "dispatch",
  "receivedAt": "2026-09-29T09:27:00Z",
  "audioMime": "audio/wav",
  "audioBase64": "...",
  "metadata": { "system": "primary" }
}
```

`eventType` is `tone` or `dispatch`. A tone-only event followed by a dispatch on the same selected talkgroup is folded into the tone incident within `TONE_CORRELATION_SECONDS`. Send the call audio as base64 in the webhook (maximum decoded size 64 MB), or upload audio later from a reviewer account. Ingestion persists the event before queueing work; a queue outage is logged and pending audio is recovered by the worker after Redis returns.

Page-tone analysis runs on decoded mono audio using Goertzel detection. Set `PAGE_TONE_HZ` to comma-separated frequencies and tune `PAGE_TONE_THRESHOLD`; detection metadata is kept internally. Native Rdio Scanner and SDRTrunk uploads are classified as tone-only before transcription when a configured page tone is detected, allowing the next same-talkgroup dispatch within `TONE_CORRELATION_SECONDS` to be attached to that incident. The normalized JSON endpoint also accepts an explicit `eventType: "tone"` or `"dispatch"`.

## Local AI providers

The Whisper adapter uses an OpenAI-compatible `/audio/transcriptions` endpoint (`WHISPER_BASE_URL`, `WHISPER_MODEL`, optional `WHISPER_API_KEY`). The reasoning adapter uses an OpenAI-compatible chat-completions endpoint (`AI_BASE_URL`, `AI_MODEL`, optional `AI_API_KEY`); the included Ollama service is the default local reasoning runtime. Provider access is isolated in `api/src/adapters.ts`; audio and image persistence is behind `StorageAdapter` in `api/src/storage.ts`, with local filesystem storage as the default implementation.

Reasoning output must parse against a strict schema. The application applies deterministic address, direct-identifier, sensitivity, and output-format checks after inference. Exact extracted addresses and transcripts are stored only in internal fields; public post data is stored separately. Extra public information is suppressed unless `ALLOW_PUBLIC_EXTRA_INFO=true` is explicitly set. High-sensitivity calls publish only a generic call and jurisdiction/time, with no location or extra details. Review every draft before approval.

Set `TIME_ZONE` to the jurisdiction's IANA time zone so the generated `(HH:MM hrs)` line reflects local time.

## Human review and publication

Every automated result is a draft. Reviewers and administrators can inspect private audio/transcripts, edit sanitized fields, select only an enabled image-bank asset, save, reject, or approve. Approval writes an immutable user-and-content record. Facebook publication is a separate action; the server-side worker verifies the latest approval snapshot again, claims a unique publication job, and refuses already-published incidents. Automated processing has no Facebook credential or publication path. Publication attempts are single-shot; after a failure, reconcile the Facebook Page before using **Retry Facebook**, since an upstream timeout can make the result ambiguous.

`FACEBOOK_PAGE_ID` and `FACEBOOK_ACCESS_TOKEN` are consumed only by the publisher worker. The configured image is uploaded as an unpublished Page photo and attached to the approved post. Public audio links use a separate HMAC-derived 128-bit token; only its one-way hash is stored, and audio is served only while the latest approval matches the current post. High-sensitivity recordings remain reviewer-only and are never attached as public links. Keep `PUBLIC_AUDIO_SECRET` stable and private. Raw audio and transcripts require reviewer/admin access. Use HTTPS at the reverse proxy for all non-local deployments.

## Roles and API

- **Admin**: review/publish, configure talkgroups and images, create accounts, view the audit log.
- **Reviewer**: inspect internal data, manage drafts, approve/reject, and explicitly publish/retry.
- **Viewer**: read sanitized incident data only.

The bootstrap account is created on first API startup when its environment credentials are valid. Add accounts through the authenticated `POST /api/users` endpoint with an Admin bearer token. Login is `POST /api/auth/login`; the dashboard uses an eight-hour signed JWT. Ingestion uses its separate API key.

Useful endpoints include `POST /api/call-upload` (Rdio Scanner), `POST /api/broadcastify/call-upload` plus the returned MP3 PUT URL (SDRTrunk), Admin-only `GET/POST/DELETE /api/radio-keys`, `GET /api/incidents`, `GET /api/incidents/:id`, `POST /api/incidents`, `PATCH /api/incidents/:id`, `POST /api/incidents/:id/reprocess`, `POST /api/incidents/:id/approve`, `POST /api/incidents/:id/reject`, `POST /api/incidents/:id/publish`, `GET /api/audit`, `GET/POST /api/talkgroups`, and `GET/POST/PATCH /api/images`. `GET /api/health` is the readiness endpoint.

## Operations

- Audio originals and playable MP3s are in the `audio-data` Docker volume. Back up this volume with PostgreSQL; protect and encrypt backups because originals and transcripts are sensitive.
- PostgreSQL schema is in ordered files under `api/migrations/`; the migration runner records applied filenames and Compose runs it before API/worker startup. Back up before schema changes.
- The Redis volume persists queue state. Worker jobs retry processing failures with backoff; exhausted jobs remain visible in the incident audit/source metadata. Facebook jobs do not retry automatically.
- Watch `docker compose logs -f api worker migrate`. Never put provider credentials in the frontend or browser storage configuration.
- Set an external backup/restore schedule, HTTPS reverse proxy, firewall rules, and secret rotation policy before production use. The included Compose file is a single-host deployment baseline, not a substitute for those controls.

## Local development and tests

Requires Node.js 22+, npm, PostgreSQL 16+, Redis 7+, and FFmpeg on the API/worker `PATH`.

```powershell
npm install
npm run db:migrate
npm test
npm run dev
```

The dashboard is at `http://localhost:5173`; point `DATABASE_URL`, `REDIS_URL`, and `STORAGE_DIR` to local services. Privacy and post rendering tests are in `api/src/privacy.test.ts`. Build both applications with `npm run build`.