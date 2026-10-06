import './env.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { query, transaction } from './db.js';
import { OpenAICompatibleReasoner, OpenAICompatibleWhisper, MetaGraphPublisher, PublicationClaimedError, PublicationRejectedError, PublicationUncertainError } from './adapters.js';
import { claimNextJob, completeJob, failJob, onWorkerWake, setWorkerOnline, type WorkJob } from './queue.js';
import { hasMatchingApproval, renderOfficialPost, publicPostSchema } from './types.js';
import { sanitizePublicPost } from './privacy.js';
import { detectConfiguredTones } from './tones.js';
import { suggestCall, suggestPriority } from './priorities.js';
import { storage } from './storage.js';

const execFileAsync = promisify(execFile);
const transcriber = new OpenAICompatibleWhisper();
const reasoner = new OpenAICompatibleReasoner();
const publisher = new MetaGraphPublisher();
const processing = new Set<string>();
let loopTimer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let stopped = true;
let recovering = false;

async function processIncident(incidentId: string) {
  if (processing.has(incidentId)) return;
  processing.add(incidentId);
  try {
    const result = await query('SELECT * FROM incidents WHERE id=$1', [incidentId]);
    const incident = result.rows[0];
    if (!incident || incident.status !== 'processing') return;
    if (!incident.original_path) throw new Error('Incident has no audio attached yet');
    const sourcePaths = Array.isArray(incident.source_metadata?.audioSources) ? incident.source_metadata.audioSources as string[] : [incident.original_path];
    const safeSources = [...new Set(sourcePaths)].filter(path => /^[a-f0-9-]{36}\.[a-z0-9._-]{1,64}$/i.test(path));
    if (!safeSources.length) throw new Error('Incident audio source is invalid');
    const stageDir = await mkdtemp(join(tmpdir(), 'signaldesk-'));
    const stagedSources: { cleanup: () => Promise<void> }[] = [];
    try {
      const localSources: string[] = [];
      for (const source of safeSources) {
        const materialized = await storage.materialize(source);
        stagedSources.push(materialized);
        localSources.push(materialized.path);
      }
      const playablePath = join(stageDir, `${incidentId}.mp3`);
      const ffmpegArgs = ['-nostdin', '-y'];
      for (const source of localSources) ffmpegArgs.push('-i', source);
      if (localSources.length > 1) {
        const inputs = localSources.map((_, index) => `[${index}:a]`).join('');
        ffmpegArgs.push('-filter_complex', `${inputs}concat=n=${localSources.length}:v=0:a=1[out]`, '-map', '[out]');
      }
      ffmpegArgs.push('-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', playablePath);
      await execFileAsync('ffmpeg', ffmpegArgs);
      const playableKey = `${incidentId}.mp3`;
      await storage.putFile(playableKey, playablePath);
      const pcmResult = await execFileAsync('ffmpeg', ['-nostdin', '-v', 'error', '-i', playablePath, '-f', 's16le', '-ac', '1', '-ar', '8000', '-'], { encoding: 'buffer', maxBuffer: 100 * 1024 * 1024 });
      const configured = (process.env.PAGE_TONE_HZ ?? '').split(',').map(Number).filter(value => value > 0);
      const tone = detectConfiguredTones(pcmResult.stdout as unknown as Buffer, 8000, configured, Number(process.env.PAGE_TONE_THRESHOLD ?? 0.18));
      const prepared = await query(`UPDATE incidents SET playable_path=$2,source_metadata=source_metadata || $3::jsonb,
        event_type=CASE WHEN $4::boolean AND event_type <> 'manual' THEN 'tone' ELSE event_type END,updated_at=now()
        WHERE id=$1 AND status='processing' RETURNING id`, [incidentId, playableKey, { pageTone: tone }, tone.detected]);
      if (!prepared.rowCount) return;
      const transcript = process.env.WHISPER_BASE_URL ? await transcriber.transcribe(await storage.read(playableKey)) : '';
      const priority = suggestPriority(transcript);
      await query("UPDATE incidents SET transcript=$2,updated_at=now() WHERE id=$1 AND status='processing'", [incidentId, transcript]);
      if (incident.event_type === 'manual') {
        await query(`UPDATE incidents SET playable_path=$2,transcript=$3,source_metadata=source_metadata || $4::jsonb,
          priority=$5,status='draft',updated_at=now() WHERE id=$1 AND status='processing'`, [incidentId, playableKey, transcript, { pageTone: tone }, priority]);
        return;
      }
      const images = await query<{ id: string; location: string; name: string }>('SELECT id, location, name FROM images WHERE enabled=true');
      const receivedAt = new Date(incident.received_at);
      const timeReceived = new Intl.DateTimeFormat('en-GB', { timeZone: process.env.TIME_ZONE ?? 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(receivedAt) + ' hrs';
      const extraction = process.env.AI_BASE_URL && transcript
        ? await reasoner.extract(transcript, receivedAt, images.rows.map(image => image.name))
        : null;
      const privateData = extraction
        ? { exactAddress: extraction.exactAddress ?? null, rawExtraction: extraction, prioritySuggestion: priority }
        : { processingNote: transcript ? 'Reasoning AI is not configured; complete this draft manually.' : 'Transcription is not configured; complete this draft manually.', prioritySuggestion: priority };
      const suggestedCall = suggestCall(transcript);
      const safe = extraction
        ? sanitizePublicPost({ ...extraction, timeReceived }, transcript)
        : sanitizePublicPost({ jurisdiction: 'Review required', call: suggestedCall ?? 'Radio call details pending', location: '', extraInfo: '', timeReceived, sensitivity: 'low', suggestedImage: null }, transcript);
      const image = extraction ? images.rows.find(item => item.name === safe.suggestedImage || item.location.toLowerCase() === safe.jurisdiction.toLowerCase()) : undefined;
      safe.suggestedImage = image?.name ?? null;
      await query(`UPDATE incidents SET playable_path=$2,transcript=$3,internal_data=$4,public_data=$5,
        image_id=$6,source_metadata=source_metadata || $7::jsonb,priority=$8,status='draft',updated_at=now() WHERE id=$1 AND status='processing'`,
      [incidentId, playableKey, transcript, privateData, publicPostSchema.parse(safe), image?.id ?? null, { pageTone: tone }, priority]);
    } finally {
      await Promise.allSettled(stagedSources.map(source => source.cleanup()));
      await rm(stageDir, { recursive: true, force: true });
    }
  } finally { processing.delete(incidentId); }
}

async function publishIncident(incidentId: string) {
  const result = await query(`SELECT i.*,a.public_snapshot,im.path AS image_key,im.name AS image_name FROM incidents i
    LEFT JOIN images im ON im.id=i.image_id AND im.enabled=true
    JOIN LATERAL (SELECT public_snapshot FROM approvals WHERE incident_id=i.id ORDER BY created_at DESC LIMIT 1) a ON true
    JOIN publish_jobs p ON p.incident_id=i.id WHERE i.id=$1`, [incidentId]);
  const incident = result.rows[0];
  if (!incident) throw new Error('Publish request or human approval not found');
  if (incident.image_id && !incident.image_key) throw new Error('Approved image is no longer enabled; select an active image and approve the post again');
  if (!['approved','publish_queued','publish_failed'].includes(incident.status)) throw new Error('Incident is not approved for publication');
  if (!incident.playable_path && incident.event_type !== 'manual') throw new Error('Approved radio incident has no playable audio');
  const current = publicPostSchema.parse(incident.public_data);
  if (!hasMatchingApproval(current, incident.public_snapshot)) throw new Error('Approval does not match the current public post; approve the latest edit');
  if (incident.facebook_post_id) throw new Error('Incident has already been published');
  publisher.validateConfiguration();
  const claimed = await query("UPDATE publish_jobs SET status='publishing',attempts=attempts+1,updated_at=now() WHERE incident_id=$1 AND status='queued' RETURNING incident_id", [incidentId]);
  if (!claimed.rowCount) throw new PublicationClaimedError('Another local job owns this publication');
  const audioToken = createHmac('sha256', process.env.PUBLIC_AUDIO_SECRET ?? process.env.JWT_SECRET ?? 'development-only-audio-secret').update(incident.id).digest('hex').slice(0, 32);
  const audioUrl = current.includeAudio && incident.playable_path && current.sensitivity !== 'high' ? `${(process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/public/audio/${audioToken}` : undefined;
  const imageMimeType: 'image/png'|'image/jpeg'|'image/webp'|undefined = incident.image_key?.toLowerCase().endsWith('.png') ? 'image/png'
    : incident.image_key?.toLowerCase().endsWith('.webp') ? 'image/webp'
      : incident.image_key ? 'image/jpeg' : undefined;
  const image = incident.image_key && imageMimeType ? {
    name: incident.image_name as string,
    mimeType: imageMimeType,
    data: await storage.read(incident.image_key as string)
  } : undefined;
  const postId = await publisher.publish(renderOfficialPost(current), audioUrl, image);
  const journal = await query("UPDATE publish_jobs SET status='remote_created',facebook_post_id=$2,updated_at=now() WHERE incident_id=$1 AND status='publishing' RETURNING incident_id", [incidentId, postId]);
  if (!journal.rowCount) throw new PublicationUncertainError(`Facebook created post ${postId}, but its ID could not be recorded.`);
  await finalizePublication(incidentId, postId);
}

async function finalizePublication(incidentId: string, postId: string) {
  await transaction(async tx => {
    const result = await tx.query("UPDATE incidents SET status='published',facebook_post_id=$2,publish_error=NULL,updated_at=now() WHERE id=$1 AND (facebook_post_id IS NULL OR facebook_post_id=$2)", [incidentId, postId]);
    if (!result.rowCount) throw new Error('A different Facebook post ID is already recorded for this incident');
    await tx.query("UPDATE publish_jobs SET status='published',facebook_post_id=$2,error=NULL,updated_at=now() WHERE incident_id=$1", [incidentId, postId]);
    await tx.query("INSERT INTO audit_log(action,incident_id,details) VALUES ('facebook.published',$1,$2) ON CONFLICT DO NOTHING", [incidentId, { facebookPostId: postId }]);
  });
}

async function handleJob(job: WorkJob) {
  try {
    if (job.payload.type === 'process') await processIncident(job.payload.incidentId);
    else await publishIncident(job.payload.incidentId);
    await completeJob(job.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error({ incidentId: job.payload.incidentId, jobType: job.payload.type, error: message }, 'Background job failed');
    if (job.payload.type === 'process') {
      if (job.attempts >= job.maxAttempts) await query("UPDATE incidents SET status='draft',source_metadata=source_metadata || $2::jsonb,updated_at=now() WHERE id=$1", [job.payload.incidentId, { processingError: message.slice(0, 500) }]);
    } else {
      const recorded = await query<{ status: string; facebook_post_id: string|null }>('SELECT status,facebook_post_id FROM publish_jobs WHERE incident_id=$1', [job.payload.incidentId]);
      if (['remote_created','published'].includes(recorded.rows[0]?.status ?? '') && recorded.rows[0]?.facebook_post_id) {
        await finalizePublication(job.payload.incidentId, recorded.rows[0].facebook_post_id);
      } else if (error instanceof PublicationUncertainError || recorded.rows[0]?.status === 'publishing' && !(error instanceof PublicationRejectedError)) {
        await query("UPDATE incidents SET status='publish_unknown',publish_error=$2,updated_at=now() WHERE id=$1", [job.payload.incidentId, message.slice(0, 500)]);
        await query("UPDATE publish_jobs SET status='unknown',error=$2,updated_at=now() WHERE incident_id=$1", [job.payload.incidentId, message.slice(0, 500)]);
      } else {
        await query("UPDATE incidents SET status='publish_failed',publish_error=$2,updated_at=now() WHERE id=$1", [job.payload.incidentId, message.slice(0, 500)]);
        await query("UPDATE publish_jobs SET status='failed',error=$2,updated_at=now() WHERE incident_id=$1", [job.payload.incidentId, message.slice(0, 500)]);
      }
    }
    await failJob(job, message, Math.min(30_000, 2000 * 2 ** Math.max(0, job.attempts - 1)));
  }
}

async function tick() {
  if (running || stopped || recovering) return;
  running = true;
  setWorkerOnline(true);
  try {
    const job = await claimNextJob();
    if (job) await handleJob(job);
  } catch (error) {
    console.error({ error: error instanceof Error ? error.message : String(error) }, 'Local job runner failed');
  } finally {
    running = false;
    if (!stopped) loopTimer = setTimeout(() => void tick(), 500);
  }
}

export function startWorker() {
  stopped = false;
  recovering = true;
  onWorkerWake(() => void tick());
  void recoverInterruptedJobs().catch(error => console.error({ error }, 'Local job recovery failed')).finally(() => {
    recovering = false;
    setWorkerOnline(true);
    void tick();
  });
}

export function stopWorker() {
  stopped = true;
  setWorkerOnline(false);
  if (loopTimer) clearTimeout(loopTimer);
}

async function recoverInterruptedJobs() {
  await query("DELETE FROM background_jobs WHERE status='complete' AND created_at < now() - interval '7 days'");
  const interrupted = await query<{ id: string; job_type: string; payload: { incidentId: string } }>("SELECT id,job_type,payload FROM background_jobs WHERE status='processing'");
  for (const job of interrupted.rows) {
    if (job.job_type === 'process') {
      await query("UPDATE background_jobs SET status='queued',run_after=now(),updated_at=now() WHERE id=$1", [job.id]);
      continue;
    }
    const publish = await query<{ status: string; facebook_post_id: string|null }>('SELECT status,facebook_post_id FROM publish_jobs WHERE incident_id=$1', [job.payload.incidentId]);
    if (publish.rows[0]?.status === 'remote_created' && publish.rows[0].facebook_post_id) {
      await finalizePublication(job.payload.incidentId, publish.rows[0].facebook_post_id);
      await completeJob(job.id);
    } else {
      const message = 'Application restarted during Facebook publication. Verify the Page before retrying.';
      await query("UPDATE incidents SET status='publish_unknown',publish_error=$2,updated_at=now() WHERE id=$1 AND status='publish_queued'", [job.payload.incidentId, message]);
      await query("UPDATE publish_jobs SET status='unknown',error=$2,updated_at=now() WHERE incident_id=$1 AND status='publishing'", [job.payload.incidentId, message]);
      await query("UPDATE background_jobs SET status='failed',last_error=$2,updated_at=now() WHERE id=$1", [job.id, message]);
    }
  }
}