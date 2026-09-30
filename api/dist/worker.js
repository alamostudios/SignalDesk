import './env.js';
import { Worker } from 'bullmq';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { pool, query } from './db.js';
import { OpenAICompatibleReasoner, OpenAICompatibleWhisper, MetaGraphPublisher, PublicationClaimedError, PublicationRejectedError, PublicationUncertainError } from './adapters.js';
import { queue, redis } from './queue.js';
import { hasMatchingApproval, renderOfficialPost, publicPostSchema } from './types.js';
import { sanitizePublicPost } from './privacy.js';
import { detectConfiguredTones } from './tones.js';
import { storage } from './storage.js';
const execFileAsync = promisify(execFile);
const transcriber = new OpenAICompatibleWhisper();
const reasoner = new OpenAICompatibleReasoner();
const publisher = new MetaGraphPublisher();
async function processIncident(incidentId) {
    const client = await pool.connect();
    try {
        const result = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [incidentId]);
        if (!result.rows[0]?.acquired)
            return;
        try {
            await processIncidentUnlocked(incidentId);
        }
        finally {
            await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [incidentId]);
        }
    }
    finally {
        client.release();
    }
}
async function processIncidentUnlocked(incidentId) {
    const result = await query('SELECT * FROM incidents WHERE id=$1', [incidentId]);
    const incident = result.rows[0];
    if (!incident || incident.status !== 'processing')
        return;
    if (!incident.original_path)
        throw new Error('Incident has no audio attached yet');
    const sourcePaths = Array.isArray(incident.source_metadata?.audioSources) ? incident.source_metadata.audioSources : [incident.original_path];
    const safeSources = [...new Set(sourcePaths)].filter(path => /^[a-f0-9-]{36}\.[a-z0-9._-]{1,64}$/i.test(path));
    if (!safeSources.length)
        throw new Error('Incident audio source is invalid');
    const stageDir = await mkdtemp(join(tmpdir(), 'rdio-'));
    const stagedSources = [];
    try {
        const localSources = [];
        for (const source of safeSources) {
            const materialized = await storage.materialize(source);
            stagedSources.push(materialized);
            localSources.push(materialized.path);
        }
        const playablePath = join(stageDir, `${incidentId}.mp3`);
        const ffmpegArgs = ['-nostdin', '-y'];
        for (const source of localSources)
            ffmpegArgs.push('-i', source);
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
        const tone = detectConfiguredTones(pcmResult.stdout, 8000, configured, Number(process.env.PAGE_TONE_THRESHOLD ?? 0.18));
        await query(`UPDATE incidents SET playable_path=$2,source_metadata=source_metadata || $3::jsonb,
      event_type=CASE WHEN $4::boolean THEN 'tone' ELSE event_type END,updated_at=now() WHERE id=$1`, [incidentId, playableKey, { pageTone: tone }, tone.detected]);
        const transcript = await transcriber.transcribe(await storage.read(playableKey));
        await query('UPDATE incidents SET transcript=$2,updated_at=now() WHERE id=$1', [incidentId, transcript]);
        const images = await query('SELECT id, location, name FROM images WHERE enabled=true');
        const receivedAt = new Date(incident.received_at);
        const extraction = await reasoner.extract(transcript, receivedAt, images.rows.map(image => image.name));
        const privateData = { exactAddress: extraction.exactAddress ?? null, rawExtraction: extraction };
        const timeReceived = new Intl.DateTimeFormat('en-GB', { timeZone: process.env.TIME_ZONE ?? 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(receivedAt) + ' hrs';
        const safe = sanitizePublicPost({ ...extraction, timeReceived }, transcript);
        const image = images.rows.find(item => item.name === safe.suggestedImage || item.location.toLowerCase() === safe.jurisdiction.toLowerCase());
        if (image)
            safe.suggestedImage = image.name;
        else
            safe.suggestedImage = null;
        const selectedImageId = image?.id ?? null;
        await query(`UPDATE incidents SET playable_path=$2, transcript=$3, internal_data=$4, public_data=$5,
      image_id=$6, source_metadata=source_metadata || $7::jsonb, status='draft', updated_at=now() WHERE id=$1`, [incidentId, playableKey, transcript, privateData, publicPostSchema.parse(safe), selectedImageId, { pageTone: tone }]);
    }
    finally {
        await Promise.allSettled(stagedSources.map(source => source.cleanup()));
        await rm(stageDir, { recursive: true, force: true });
    }
}
async function publishIncident(incidentId) {
    const result = await query(`SELECT i.*, a.public_snapshot, im.path AS image_key, im.name AS image_name FROM incidents i
    LEFT JOIN images im ON im.id=i.image_id AND im.enabled=true
    JOIN LATERAL (SELECT public_snapshot FROM approvals WHERE incident_id=i.id ORDER BY created_at DESC LIMIT 1) a ON true
    JOIN publish_jobs p ON p.incident_id=i.id WHERE i.id=$1 FOR UPDATE OF i`, [incidentId]);
    const incident = result.rows[0];
    if (!incident)
        throw new Error('Publish request or human approval not found');
    if (incident.image_id && !incident.image_key)
        throw new Error('Approved image is no longer enabled; select an active image and approve the post again');
    if (!['approved', 'publish_queued', 'publish_failed'].includes(incident.status))
        throw new Error('Incident is not approved for publication');
    if (!incident.playable_path && incident.event_type !== 'manual')
        throw new Error('Approved radio incident has no playable audio');
    const current = publicPostSchema.parse(incident.public_data);
    if (!hasMatchingApproval(current, incident.public_snapshot))
        throw new Error('Approval does not match the current public post; approve the latest edit');
    if (incident.facebook_post_id)
        throw new Error('Incident has already been published');
    const latest = await query('SELECT id FROM approvals WHERE incident_id=$1 ORDER BY created_at DESC LIMIT 1', [incidentId]);
    const latestApproval = latest.rows[0];
    if (!latestApproval)
        throw new Error('Human approval is required');
    const audioToken = createHmac('sha256', process.env.PUBLIC_AUDIO_SECRET ?? process.env.JWT_SECRET ?? 'development-only-audio-secret').update(incident.id).digest('hex').slice(0, 32);
    const audioUrl = incident.playable_path && current.sensitivity !== 'high' ? `${(process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/public/audio/${audioToken}` : undefined;
    const image = incident.image_key ? { name: incident.image_name, data: await storage.read(incident.image_key) } : undefined;
    publisher.validateConfiguration();
    const claimed = await query("UPDATE publish_jobs SET status='publishing',attempts=attempts+1,updated_at=now() WHERE incident_id=$1 AND status='queued' RETURNING incident_id", [incidentId]);
    if (!claimed.rowCount)
        throw new PublicationClaimedError('Another worker owns or completed this publication job');
    const postId = await publisher.publish(renderOfficialPost(current), audioUrl, image);
    try {
        const journal = await query("UPDATE publish_jobs SET status='remote_created',facebook_post_id=$2,updated_at=now() WHERE incident_id=$1 AND status='publishing' RETURNING incident_id", [incidentId, postId]);
        if (!journal.rowCount)
            throw new Error('Publication journal claim was lost');
    }
    catch {
        throw new PublicationUncertainError(`Facebook created post ${postId}, but its ID could not be durably recorded. An administrator must reconcile it before another attempt.`);
    }
    await finalizePublication(incidentId, postId);
}
async function finalizePublication(incidentId, postId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const published = await client.query("UPDATE incidents SET status='published', facebook_post_id=$2, publish_error=NULL, updated_at=now() WHERE id=$1 AND (facebook_post_id IS NULL OR facebook_post_id=$2)", [incidentId, postId]);
        if (!published.rowCount)
            throw new Error('A different Facebook post ID is already recorded for this incident');
        await client.query("UPDATE publish_jobs SET status='published', facebook_post_id=$2, error=NULL, updated_at=now() WHERE incident_id=$1", [incidentId, postId]);
        await client.query("INSERT INTO audit_log(action,incident_id,details) VALUES ('facebook.published',$1,$2) ON CONFLICT DO NOTHING", [incidentId, { facebookPostId: postId }]);
        await client.query('COMMIT');
    }
    catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
    finally {
        client.release();
    }
}
const worker = new Worker('rdio-work', async (job) => {
    if (job.data.type === 'process')
        await processIncident(job.data.incidentId);
    else
        await publishIncident(job.data.incidentId);
}, { connection: redis, concurrency: 4, maxStalledCount: 0 });
worker.on('failed', async (job, error) => {
    if (!job || job.attemptsMade < Number(job.opts.attempts ?? 1))
        return;
    if (error instanceof PublicationClaimedError)
        return;
    const incidentId = job.data.incidentId;
    console.error({ incidentId, job: job.data.type, error: error.message }, 'Background job exhausted retries');
    if (job.data.type === 'publish') {
        const recorded = await query('SELECT status,facebook_post_id FROM publish_jobs WHERE incident_id=$1', [incidentId]);
        if (['remote_created', 'published'].includes(recorded.rows[0]?.status ?? '') && recorded.rows[0]?.facebook_post_id) {
            try {
                await finalizePublication(incidentId, recorded.rows[0].facebook_post_id);
            }
            catch (finalizeError) {
                console.error({ incidentId, error: finalizeError }, 'Known Facebook post awaits database reconciliation');
            }
        }
        else if (error instanceof PublicationUncertainError || recorded.rows[0]?.status === 'publishing' && !(error instanceof PublicationRejectedError)) {
            await query("UPDATE incidents SET status='publish_unknown',publish_error=$2,updated_at=now() WHERE id=$1", [incidentId, error.message.slice(0, 500)]);
            await query("UPDATE publish_jobs SET status='unknown',error=$2,updated_at=now() WHERE incident_id=$1", [incidentId, error.message.slice(0, 500)]);
        }
        else {
            await query("UPDATE incidents SET status='publish_failed', publish_error=$2, updated_at=now() WHERE id=$1", [incidentId, error.message.slice(0, 500)]);
            await query("UPDATE publish_jobs SET status='failed', error=$2, updated_at=now() WHERE incident_id=$1", [incidentId, error.message.slice(0, 500)]);
        }
    }
    else {
        await query("UPDATE incidents SET status='draft', source_metadata=source_metadata || $2::jsonb, updated_at=now() WHERE id=$1", [incidentId, { processingError: error.message.slice(0, 500) }]);
    }
});
console.info('Radio processing and publisher worker started');
const recoveryTimer = setInterval(async () => {
    try {
        if (redis.status !== 'ready')
            return;
        await redis.set('rdio:worker:heartbeat', String(Date.now()), 'EX', 35);
        const pending = await query("SELECT id,updated_at FROM incidents WHERE status='processing' AND original_path IS NOT NULL ORDER BY updated_at LIMIT 100");
        const active = await queue.getJobs(['active', 'waiting', 'delayed', 'prioritized']);
        const activeIds = new Set(active.map(job => job.data.incidentId));
        for (const incident of pending.rows) {
            if (!activeIds.has(incident.id))
                await queue.add('recover-process', { type: 'process', incidentId: incident.id }, { jobId: `recovery-${incident.id}-${new Date(incident.updated_at).getTime()}`, attempts: 4, backoff: { type: 'exponential', delay: 3000 } });
        }
        const pendingPublish = await query(`SELECT i.id,p.updated_at FROM incidents i JOIN publish_jobs p ON p.incident_id=i.id
      WHERE i.status='publish_queued' AND p.status='queued' ORDER BY p.updated_at LIMIT 100`);
        for (const incident of pendingPublish.rows) {
            if (!activeIds.has(incident.id))
                await queue.add('recover-publish', { type: 'publish', incidentId: incident.id }, { jobId: `recover-publish-${incident.id}-${new Date(incident.updated_at).getTime()}`, attempts: 1 });
        }
        const knownRemote = await query("SELECT incident_id,facebook_post_id FROM publish_jobs WHERE status='remote_created' AND facebook_post_id IS NOT NULL");
        for (const item of knownRemote.rows)
            await finalizePublication(item.incident_id, item.facebook_post_id);
        const stalePublish = await query(`UPDATE publish_jobs SET status='unknown',error='Publisher stopped during external request; verify Facebook before retry',updated_at=now()
      WHERE status='publishing' AND updated_at < now() - interval '2 minutes' RETURNING incident_id`);
        for (const item of stalePublish.rows)
            await query("UPDATE incidents SET status='publish_unknown',publish_error='Publisher stopped during external request; verify Facebook before retry',updated_at=now() WHERE id=$1 AND status='publish_queued'", [item.incident_id]);
    }
    catch (error) {
        console.error({ error: error instanceof Error ? error.message : String(error) }, 'Queue recovery scan failed');
    }
}, 15000);
for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, async () => { clearInterval(recoveryTimer); await redis.del('rdio:worker:heartbeat'); await worker.close(); await queue.close(); await redis.quit(); await pool.end(); process.exit(0); });
