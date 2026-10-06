# Signal Desk

A small developer-operated radio-call review app. SDRTrunk and Rdio Scanner run separately and send audio into Signal Desk. The Node app includes its own Postgres-compatible PGlite database, local job runner, and the Signal Desk UI. No PostgreSQL, Redis, Ollama, Nginx, or scanner container is required.

## Run Locally

Requirements: Node.js 22+ and FFmpeg on `PATH`. Run:

```powershell
npm install
npm run dev
```

Open `http://localhost:5173`. API and scanner receiver: `http://localhost:3000`. Migrations run automatically. Database files go in `data/`; audio goes in `storage/`. On first run, signing keys and an admin password are generated automatically and saved under `data/`. Find the initial sign-in at `data/initial-admin.txt` and keep it private. A `.env` file is optional for overrides.

If PowerShell cannot find `npm`, use `& 'C:\Program Files\nodejs\npm.cmd' install` and `& 'C:\Program Files\nodejs\npm.cmd' run dev`.

Docker Compose includes a local, CPU-only `whisper.cpp` service using the free MIT-licensed `tiny.en` model. The model is about 75 MiB and is downloaded once into a persistent volume; inference is limited to two CPU threads by default. Transcripts and regex-based priority suggestions run locally, with no Whisper API key or hosted AI required. Set `WHISPER_CPP_MODEL=base.en` for better accuracy at higher memory and CPU cost, or change `WHISPER_THREADS` to tune usage. Reasoning AI remains optional and is configured with `AI_BASE_URL`.

`npm run dev` starts the app and web UI, but not the Whisper service. For local transcription during development, run Whisper separately and set `WHISPER_BASE_URL` and `WHISPER_API_PATH` in `.env` (`/inference` for whisper.cpp). Facebook credentials are optional until you want to publish approved posts.

## One-Container Docker

To start without configuring secrets first (including local speech-to-text):

```powershell
docker compose up --build -d
docker compose logs -f signaldesk
```

Open `http://localhost:3000`. This starts exactly one container. The database and recordings persist in Docker volumes. The Compose file exposes optional overrides for Coolify; set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` in its Environment Variables to choose the admin login. The configured bootstrap password is synchronized to that account on startup. If omitted, credentials are generated and saved in `/app/data/initial-admin.txt`. Set `PUBLIC_BASE_URL` to the external HTTPS URL for scanner uploads and public audio links.

## Connect the Scanner

1. Sign into Signal Desk using `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`.
2. In Configuration, create a receiver key with the numeric System ID. The raw key is shown once; copy it then. Talkgroups do not need to be configured in Signal Desk.
3. Configure SDRTrunk to send using its Rdio Scanner-compatible call upload to `https://<signal-desk-host>/api/call-upload` (for local HTTP use `http://<signal-desk-host>:3000/api/call-upload`). Use the same System ID and receiver key. Signal Desk accepts every talkgroup sent by SDRTrunk and lists received talkgroups automatically.
4. Open **Receiver monitor** while signed in to see sanitized request status, system/talkgroup IDs, and audio sizes. Request entries are read-only; API keys and audio contents are never displayed or stored in the monitor.

Generated keys are hashed at rest, restricted to their System ID, and revocable. SDRTrunk itself is not included in this repository or container.

Page-tone detection runs during audio conversion. Set `PAGE_TONE_HZ`, `PAGE_TONE_THRESHOLD`, and `TONE_CORRELATION_SECONDS` in `.env`. Tone calls and a following same-talkgroup dispatch are combined when detected inside the correlation window.

## Safe Publishing

Every automated call becomes a draft. The application renders the fixed post format; AI never writes post text or publishes. A human must approve before the separate Facebook publish action is available. High-sensitivity calls retain private recordings and receive no public audio link. If a Facebook request times out after submission, the post is marked for manual reconciliation instead of offering a blind retry.

## Checks

```powershell
npm test
npm run build
```

Receiver route: `POST /api/call-upload`. Authenticated request monitoring is available in the Receiver monitor. Admin key management is under `/api/radio-keys`.
