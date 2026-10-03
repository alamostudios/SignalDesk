# Signal Desk

A small developer-operated radio-call review app. SDRTrunk and Rdio Scanner run separately and send audio into Signal Desk. The Node app includes its own Postgres-compatible PGlite database, local job runner, and the Signal Desk UI. No PostgreSQL, Redis, Ollama, Nginx, or scanner container is required.

## Run Locally

Requirements: Node.js 22+ and FFmpeg on `PATH`. Copy `.env.example` to `.env`, set the bootstrap email/password plus fresh `JWT_SECRET` and `PUBLIC_AUDIO_SECRET` values, then run:

```powershell
npm install
npm run dev
```

Open `http://localhost:5173`. API and scanner receiver: `http://localhost:3000`. Migrations run automatically. Database files go in `data/`; audio goes in `storage/`.

If PowerShell cannot find `npm`, use `& 'C:\Program Files\nodejs\npm.cmd' install` and `& 'C:\Program Files\nodejs\npm.cmd' run dev`.

Whisper and reasoning AI are optional OpenAI-compatible endpoints configured with `WHISPER_BASE_URL` and `AI_BASE_URL`. Without them, calls are still saved and converted to playable audio; they appear as conservative drafts for manual completion. Facebook credentials are optional until you want to publish approved posts.

## One-Container Docker

After configuring `.env`:

```powershell
docker compose up --build -d
docker compose logs -f signaldesk
```

Open `http://localhost:3000`. This starts exactly one container. The database and recordings persist in Docker volumes. Use HTTPS and set `PUBLIC_BASE_URL` to the external URL if Facebook or public audio links must be reachable outside the host.

## Connect the Scanner

1. Sign into Signal Desk using `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`.
2. In Configuration, add/enable the talkgroups and create a receiver key with the numeric system ID and allowed talkgroups. The raw key is shown once; copy it then.
3. In SDRTrunk, add a **Broadcastify Calls** streaming configuration. Use the same System ID, the generated key, and this URL: `http://<signal-desk-host>:3000/api/broadcastify/call-upload`. The test returns `Ok`. Calls use SDRTrunk's metadata POST followed by an MP3 PUT to a short-lived URL returned by Signal Desk.
4. Rdio Scanner-compatible clients send multipart audio to `http://<signal-desk-host>:3000/api/call-upload` with `key`, `system`, `talkgroup`, and `timestamp` fields.

Generated keys are hashed at rest, scoped to enabled talkgroups, and revocable. SDRTrunk itself is not included in this repository or container.

Page-tone detection runs during audio conversion. Set `PAGE_TONE_HZ`, `PAGE_TONE_THRESHOLD`, and `TONE_CORRELATION_SECONDS` in `.env`. Tone calls and a following same-talkgroup dispatch are combined when detected inside the correlation window.

## Safe Publishing

Every automated call becomes a draft. The application renders the fixed post format; AI never writes post text or publishes. A human must approve before the separate Facebook publish action is available. High-sensitivity calls retain private recordings and receive no public audio link. If a Facebook request times out after submission, the post is marked for manual reconciliation instead of offering a blind retry.

## Checks

```powershell
npm test
npm run build
```

Receiver routes: `POST /api/call-upload`, `POST /api/broadcastify/call-upload`, and the returned short-lived `PUT /api/radio-upload/:sessionId`. Admin key management is under `/api/radio-keys`.
