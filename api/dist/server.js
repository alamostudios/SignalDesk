import './env.js';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import bcrypt from 'bcryptjs';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { extname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { audit, closeDatabase, query, transaction } from './db.js';
import { enqueueJob, workerOnline } from './queue.js';
import { publicPostSchema, renderOfficialPost } from './types.js';
import { sanitizePublicPost } from './privacy.js';
import { storage } from './storage.js';
import { radioSource } from './radio.js';
import { runMigrations } from './migrate.js';
import { startWorker, stopWorker } from './worker.js';
const app = Fastify({ logger: true, bodyLimit: 100 * 1024 * 1024, trustProxy: true });
const roles = ['Admin', 'Reviewer', 'Viewer'];
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const publicAudioToken = (incidentId) => createHmac('sha256', process.env.PUBLIC_AUDIO_SECRET ?? process.env.JWT_SECRET ?? 'development-only-audio-secret').update(incidentId).digest('hex').slice(0, 32);
app.addContentTypeParser(['audio/mpeg', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: 64 * 1024 * 1024 }, (_request, body, done) => done(null, body));
await app.register(jwt, { secret: process.env.JWT_SECRET ?? 'development-only-change-this-secret-now', sign: { expiresIn: '8h' } });
await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024, files: 1, fieldSize: 64 * 1024, fieldNameSize: 100 } });
await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
const requireRoles = (...allowed) => async (request, reply) => {
    try {
        await request.jwtVerify();
    }
    catch {
        return reply.code(401).send({ error: 'Authentication required' });
    }
    if (!allowed.includes(request.user.role))
        return reply.code(403).send({ error: 'Insufficient role' });
};
function constantTimeSecret(received, expected) {
    if (!received || !expected)
        return false;
    const left = Buffer.from(received);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
}
async function readMultipart(request) {
    const fields = {};
    let audio;
    for await (const part of request.parts()) {
        if (part.type === 'file') {
            const data = await part.toBuffer();
            if (part.fieldname === 'audio')
                audio = { data, filename: part.filename, mimetype: part.mimetype };
        }
        else
            fields[part.fieldname] = String(part.value ?? '');
    }
    return { fields, audio };
}
async function authorizeRadioKey(key, systemId, talkgroupId) {
    const hash = hashToken(key);
    const result = talkgroupId
        ? await query(`SELECT k.id FROM radio_api_keys k JOIN talkgroups t ON t.id=$3 AND t.enabled=true
      WHERE k.key_hash=$1 AND k.system_id=$2 AND k.enabled=true AND $3=ANY(k.talkgroup_ids)`, [hash, systemId, talkgroupId])
        : await query('SELECT id FROM radio_api_keys WHERE key_hash=$1 AND system_id=$2 AND enabled=true', [hash, systemId]);
    if (result.rows[0])
        void query('UPDATE radio_api_keys SET last_used_at=now() WHERE id=$1', [result.rows[0].id]).catch(error => app.log.warn({ error }, 'Could not update radio key usage time'));
    return result.rows[0]?.id ?? null;
}
function parseRadioTimestamp(value, numericUnit) {
    if (!value)
        return null;
    if (/^\d{1,16}$/.test(value)) {
        const numeric = Number(value);
        const date = new Date(numericUnit === 'seconds' ? numeric * 1000 : numeric);
        return Number.isFinite(date.getTime()) ? date : null;
    }
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}
async function saveAudio(buffer, incidentId, suffix = 'original.wav') {
    const name = `${incidentId}.${suffix}`;
    await storage.putBuffer(name, buffer);
    return name;
}
async function saveUpload(part, id, suffix) {
    if (!part)
        throw new Error('Audio file is required');
    if (!part.mimetype.startsWith('audio/'))
        throw new Error('Only audio files are accepted');
    const name = `${id}.${suffix}-${randomBytes(6).toString('hex')}${extname(part.filename).slice(0, 8) || '.audio'}`;
    await storage.putStream(name, part.file);
    if (part.file.truncated)
        throw new Error('Audio exceeds the upload size limit');
    return name;
}
async function bootstrapAdmin() {
    const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    if (!email || !password)
        throw new Error('Admin credentials could not be initialized');
    const existing = await query('SELECT id,password_hash FROM users WHERE lower(email)=lower($1)', [email]);
    if (!existing.rowCount) {
        await query('INSERT INTO users(email,password_hash,role) VALUES ($1,$2,\'Admin\')', [email.toLowerCase(), await bcrypt.hash(password, 12)]);
        app.log.info('Bootstrap administrator created');
    }
    else if (process.env.BOOTSTRAP_ADMIN_PASSWORD_GENERATED !== 'true' && !(await bcrypt.compare(password, existing.rows[0].password_hash))) {
        await query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(password, 12), existing.rows[0].id]);
        app.log.info('Bootstrap administrator password synchronized from configuration');
    }
}
app.get('/api/health', async (_request, reply) => {
    try {
        await query('SELECT 1');
        return { status: 'ok', workerOnline };
    }
    catch {
        return reply.code(503).send({ status: 'unavailable', workerOnline: false });
    }
});
app.post('/api/post-preview', { preHandler: [requireRoles(...roles)] }, async (request, reply) => {
    const input = z.object({ incidentId: z.string().uuid().optional(), publicData: publicPostSchema }).strict().safeParse(request.body);
    if (!input.success)
        return reply.code(400).send({ error: 'Complete the required post fields to preview' });
    const source = input.data.incidentId && ['Admin', 'Reviewer'].includes(request.user.role)
        ? (await query('SELECT transcript,event_type FROM incidents WHERE id=$1', [input.data.incidentId])).rows[0]
        : undefined;
    const publicData = sanitizePublicPost(input.data.publicData, source?.transcript ?? '', { applyPrivacyFilters: source?.event_type !== 'manual' });
    return { publicData, renderedPost: renderOfficialPost(publicData) };
});
app.post('/api/auth/login', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request, reply) => {
    const input = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) }).safeParse(request.body);
    if (!input.success)
        return reply.code(400).send({ error: 'Invalid credentials' });
    const result = await query('SELECT id,email,role,password_hash FROM users WHERE lower(email)=lower($1)', [input.data.email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(input.data.password, user.password_hash)))
        return reply.code(401).send({ error: 'Invalid credentials' });
    const token = app.jwt.sign({ sub: user.id, email: user.email, role: user.role });
    return { token, user: { id: user.id, email: user.email, role: user.role } };
});
app.get('/api/auth/me', { preHandler: [requireRoles(...roles)] }, async (request) => ({ id: request.user.sub, email: request.user.email, role: request.user.role }));
app.post('/api/ingest', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (request, reply) => {
    const key = request.headers['x-ingest-key'];
    if (!constantTimeSecret(Array.isArray(key) ? key[0] : key, process.env.INGEST_API_KEY))
        return reply.code(401).send({ error: 'Invalid ingestion key' });
    const input = radioSource.normalize(request.body);
    if (!input.success)
        return reply.code(400).send({ error: 'Invalid radio event', details: input.error.flatten() });
    const event = input.data;
    const configured = await query('SELECT id FROM talkgroups WHERE id=$1 AND enabled=true', [event.talkgroupId]);
    if (!configured.rowCount)
        return reply.code(202).send({ accepted: false, ignored: true, reason: 'Talkgroup is not configured' });
    if (event.externalId) {
        const duplicate = await query("SELECT id FROM incidents WHERE external_id=$1 OR source_metadata->>'dispatchExternalId'=$1", [event.externalId]);
        if (duplicate.rowCount)
            return { accepted: true, duplicate: true, incidentId: duplicate.rows[0].id };
    }
    const id = randomUUID();
    const audioBuffer = event.audioBase64 ? Buffer.from(event.audioBase64, 'base64') : null;
    if (event.audioBase64 && (!audioBuffer?.length || audioBuffer.length > 64 * 1024 * 1024))
        return reply.code(413).send({ error: 'Audio payload is invalid or exceeds 64 MB' });
    const mime = event.audioMime?.toLowerCase() ?? 'audio/wav';
    const extension = mime.includes('mpeg') ? '.mp3' : mime.includes('wav') ? '.wav' : mime.includes('ogg') ? '.ogg' : mime.includes('webm') ? '.webm' : mime.includes('mp4') ? '.m4a' : mime.includes('aac') ? '.aac' : '.bin';
    const originalPath = audioBuffer ? await saveAudio(audioBuffer, id, `original${extension}`) : null;
    const eventTime = event.receivedAt ?? new Date();
    let incidentId = id;
    if (event.eventType === 'dispatch') {
        const windowSeconds = Math.min(900, Math.max(1, Number(process.env.TONE_CORRELATION_SECONDS ?? 180)));
        const prior = await query(`SELECT id,source_metadata FROM incidents
      WHERE talkgroup_id=$1 AND event_type='tone' AND status IN ('processing','draft')
      AND received_at >= $2::timestamptz - ($3::int * interval '1 second') AND received_at <= $2::timestamptz
      AND coalesce((source_metadata->>'toneCorrelated')::boolean,false)=false
      ORDER BY received_at DESC LIMIT 1`, [event.talkgroupId, eventTime, windowSeconds]);
        if (prior.rows[0]) {
            incidentId = prior.rows[0].id;
            const sources = Array.isArray(prior.rows[0].source_metadata.audioSources) ? prior.rows[0].source_metadata.audioSources : [];
            if (originalPath)
                sources.push(originalPath);
            await query(`UPDATE incidents SET external_id=coalesce(external_id,$2), event_type='dispatch',
        original_path=coalesce(original_path,$3), received_at=$4,
        source_metadata=source_metadata || $5::jsonb,
        status=CASE WHEN coalesce(original_path,$3) IS NULL THEN 'draft' ELSE 'processing' END, updated_at=now() WHERE id=$1`, [incidentId, event.externalId ?? null, originalPath, eventTime, { toneCorrelated: true, audioSources: sources, dispatchMetadata: event.metadata, dispatchExternalId: event.externalId ?? null }]);
        }
    }
    if (incidentId === id) {
        await query(`INSERT INTO incidents(id,external_id,talkgroup_id,event_type,received_at,original_path,audio_token_hash,source_metadata,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, event.externalId ?? null, event.talkgroupId, event.eventType, eventTime, originalPath, hashToken(publicAudioToken(id)), { ...event.metadata, audioSources: originalPath ? [originalPath] : [] }, originalPath ? 'processing' : 'draft']);
    }
    if (originalPath) {
        try {
            await enqueueJob('process', { type: 'process', incidentId }, { jobId: `process-${incidentId}-${Date.now()}` });
        }
        catch (error) {
            app.log.error({ incidentId, error }, 'Audio stored; worker enqueue will be recovered');
        }
    }
    await audit(null, 'radio.ingested', incidentId, { talkgroupId: event.talkgroupId, eventType: event.eventType, correlatedTone: incidentId !== id });
    return reply.code(202).send({ accepted: true, incidentId, queued: Boolean(originalPath) });
});
async function storeInboundRadioCall(input) {
    const duplicate = await query("SELECT coalesce(merged_into,id) AS id FROM incidents WHERE external_id=$1 OR source_metadata->>'dispatchExternalId'=$1", [input.externalId]);
    if (duplicate.rows[0])
        return { id: duplicate.rows[0].id, duplicate: true };
    const id = randomUUID();
    const extension = input.audioMime.includes('mpeg') ? '.mp3' : input.audioMime.includes('mp4') ? '.m4a' : input.audioMime.includes('ogg') ? '.ogg' : input.audioMime.includes('wav') ? '.wav' : '.audio';
    const originalPath = await saveAudio(input.audio, id, `original${extension}`);
    const correlationSeconds = Math.min(900, Math.max(1, Number(process.env.TONE_CORRELATION_SECONDS ?? 180)));
    const prior = await query(`SELECT id,source_metadata FROM incidents
    WHERE talkgroup_id=$1 AND event_type='tone' AND status IN ('processing','draft')
      AND received_at >= $2::timestamptz - ($3::int * interval '1 second') AND received_at <= $2::timestamptz
      AND merged_into IS NULL AND coalesce((source_metadata->>'toneCorrelated')::boolean,false)=false
    ORDER BY received_at DESC LIMIT 1`, [input.talkgroupId, input.receivedAt, correlationSeconds]);
    let incidentId = id;
    if (prior.rows[0]) {
        incidentId = prior.rows[0].id;
        const sources = Array.isArray(prior.rows[0].source_metadata.audioSources) ? prior.rows[0].source_metadata.audioSources : [];
        sources.push(originalPath);
        await query(`UPDATE incidents SET external_id=coalesce(external_id,$2),event_type='dispatch',received_at=$3,
      source_metadata=source_metadata || $4::jsonb,status='processing',updated_at=now() WHERE id=$1`, [incidentId, input.externalId, input.receivedAt, { toneCorrelated: true, dispatchExternalId: input.externalId, audioSources: sources, dispatchMetadata: input.metadata }]);
    }
    else {
        await query(`INSERT INTO incidents(id,external_id,talkgroup_id,event_type,received_at,original_path,audio_token_hash,source_metadata,status)
      VALUES ($1,$2,$3,'dispatch',$4,$5,$6,$7,'processing')`, [id, input.externalId, input.talkgroupId, input.receivedAt, originalPath, hashToken(publicAudioToken(id)), { audioSources: [originalPath], source: 'radio-api', systemId: input.systemId, radioApiKeyId: input.keyId, ...input.metadata }]);
    }
    try {
        await enqueueJob('process', { type: 'process', incidentId }, { jobId: `process-${incidentId}-${Date.now()}` });
    }
    catch (error) {
        app.log.error({ incidentId, error }, 'Radio call stored; worker enqueue will be recovered');
    }
    await audit(null, 'radio.ingested', incidentId, { source: 'radio-api', systemId: input.systemId, talkgroupId: input.talkgroupId, correlatedTone: incidentId !== id });
    return { id: incidentId, duplicate: false };
}
app.post('/api/call-upload', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
        const { fields, audio } = await readMultipart(request);
        const systemId = z.string().trim().min(1).max(50).safeParse(fields.system);
        const talkgroupId = z.string().trim().min(1).max(100).safeParse(fields.talkgroup);
        const key = z.string().min(20).max(200).safeParse(fields.key);
        const receivedAt = parseRadioTimestamp(fields.timestamp ?? fields.dateTime, 'milliseconds');
        if (!systemId.success || !talkgroupId.success || !key.success || !receivedAt || !audio || audio.data.length <= 44 || audio.data.length > 64 * 1024 * 1024) {
            return reply.code(417).send('Incomplete call data\n');
        }
        const keyId = await authorizeRadioKey(key.data, systemId.data, talkgroupId.data);
        if (!keyId)
            return reply.code(401).send('Invalid API key or talkgroup scope\n');
        const recorderFields = { ...fields };
        delete recorderFields.key;
        const inserted = await storeInboundRadioCall({
            systemId: systemId.data, talkgroupId: talkgroupId.data, receivedAt,
            externalId: `rdio-${systemId.data}-${talkgroupId.data}-${receivedAt.getTime()}-${(fields.source ?? '0').slice(0, 100)}`,
            audio: audio.data, audioMime: fields.audioMime ?? fields.audioType ?? audio.mimetype,
            metadata: { recorderFields }, keyId
        });
        return reply.type('text/plain').send(inserted.duplicate ? 'Call imported successfully.\n' : 'Call imported successfully.\n');
    }
    catch (error) {
        request.log.error({ error }, 'Rdio Scanner upload failed');
        return reply.code(400).type('text/plain').send('Invalid call upload\n');
    }
});
app.post('/api/broadcastify/call-upload', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
        const { fields } = await readMultipart(request);
        const systemId = z.string().trim().min(1).max(50).safeParse(fields.systemId);
        const key = z.string().min(20).max(200).safeParse(fields.apiKey);
        if (!systemId.success || !key.success)
            return reply.code(400).type('text/plain').send('1 Invalid-API-Key');
        const keyId = await authorizeRadioKey(key.data, systemId.data, fields.tg);
        if (!keyId)
            return reply.code(401).type('text/plain').send(`1 API-Key-Access-Denied`);
        if (fields.test !== undefined)
            return reply.type('text/plain').send('Ok');
        const talkgroupId = z.string().trim().min(1).max(100).safeParse(fields.tg);
        const timestamp = z.coerce.number().finite().positive().safeParse(fields.ts);
        const duration = z.coerce.number().finite().positive().max(3600).safeParse(fields.callDuration);
        if (!talkgroupId.success || !timestamp.success || !duration.success || fields.enc !== 'mp3') {
            return reply.code(400).type('text/plain').send('1 Invalid-Call-Metadata');
        }
        const receivedAt = new Date(timestamp.data * 1000);
        if (!Number.isFinite(receivedAt.getTime()))
            return reply.code(400).type('text/plain').send('1 Invalid-Timestamp');
        const externalId = `sdrtrunk-${systemId.data}-${talkgroupId.data}-${timestamp.data}-${(fields.src ?? '0').slice(0, 100)}`;
        const prior = await query('SELECT id,status FROM radio_upload_sessions WHERE external_id=$1', [externalId]);
        if (prior.rows[0]?.status === 'complete')
            return reply.type('text/plain').send('1 SKIPPED duplicate call');
        if (prior.rows[0]?.status === 'uploading')
            return reply.type('text/plain').send('1 UPLOAD-IN-PROGRESS');
        const sessionId = prior.rows[0]?.id ?? randomUUID();
        if (prior.rows[0]) {
            await query(`UPDATE radio_upload_sessions SET status='pending',expires_at=now() + interval '10 minutes'
        WHERE id=$1 AND status IN ('pending','failed')`, [sessionId]);
        }
        else {
            await query(`INSERT INTO radio_upload_sessions(id,radio_key_id,external_id,talkgroup_id,system_id,received_at,metadata,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,now() + interval '10 minutes')`, [sessionId, keyId, externalId, talkgroupId.data, systemId.data, receivedAt, { callDuration: duration.data, sourceId: fields.src ?? '0', sourceAlias: fields.srcId_alias ?? null, frequencyMhz: fields.freq ?? null }]);
        }
        const origin = (process.env.PUBLIC_BASE_URL || `${request.protocol}://${request.headers.host}`).replace(/\/$/, '');
        return reply.type('text/plain').send(`0 ${origin}/api/radio-upload/${sessionId}`);
    }
    catch (error) {
        request.log.error({ error }, 'SDRTrunk metadata upload failed');
        return reply.code(400).type('text/plain').send('1 Invalid-Call-Metadata');
    }
});
app.put('/api/radio-upload/:sessionId', async (request, reply) => {
    const { sessionId } = request.params;
    if (!z.string().uuid().safeParse(sessionId).success || !Buffer.isBuffer(request.body) || request.body.length < 100 || request.body.length > 64 * 1024 * 1024) {
        return reply.code(400).type('text/plain').send('Invalid audio upload');
    }
    let upload;
    try {
        upload = await transaction(async (tx) => {
            const session = await tx.query(`SELECT s.*,k.enabled AS key_enabled FROM radio_upload_sessions s
        JOIN radio_api_keys k ON k.id=s.radio_key_id WHERE s.id=$1 FOR UPDATE OF s`, [sessionId]);
            const row = session.rows[0];
            if (!row || !row.key_enabled || row.status !== 'pending' || new Date(row.expires_at).getTime() < Date.now())
                return null;
            await tx.query("UPDATE radio_upload_sessions SET status='uploading' WHERE id=$1", [sessionId]);
            return row;
        });
        if (!upload)
            return reply.code(404).type('text/plain').send('Upload session expired');
        const stored = await storeInboundRadioCall({
            systemId: upload.system_id, talkgroupId: upload.talkgroup_id, receivedAt: new Date(upload.received_at),
            externalId: upload.external_id, audio: request.body, audioMime: 'audio/mpeg', metadata: upload.metadata, keyId: upload.radio_key_id
        });
        await query("UPDATE radio_upload_sessions SET status='complete' WHERE id=$1", [sessionId]);
        return reply.type('text/plain').send(stored.duplicate ? '200' : '200');
    }
    catch (error) {
        await query("UPDATE radio_upload_sessions SET status='failed' WHERE id=$1 AND status='uploading'", [sessionId]).catch(() => undefined);
        request.log.error({ error, sessionId }, 'SDRTrunk audio upload failed');
        return reply.code(500).type('text/plain').send('Audio upload failed');
    }
});
app.get('/api/incidents', { preHandler: [requireRoles(...roles)] }, async (request, reply) => {
    const filters = z.object({ status: z.string().max(32).optional(), talkgroup: z.string().max(100).optional(), q: z.string().max(120).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }).safeParse(request.query);
    if (!filters.success)
        return reply.code(400).send({ error: 'Invalid filters' });
    const { status, talkgroup, q, limit, offset } = filters.data;
    const result = await query(`SELECT i.id,i.talkgroup_id,i.event_type,i.status,i.received_at,i.public_data,i.image_id,
      i.facebook_post_id,i.publish_error,i.created_at,t.label AS talkgroup_label,im.name AS image_name
    FROM incidents i JOIN talkgroups t ON t.id=i.talkgroup_id LEFT JOIN images im ON im.id=i.image_id
    WHERE ($1::text IS NULL OR i.status=$1) AND ($2::text IS NULL OR i.talkgroup_id=$2)
    AND ($3::text IS NULL OR concat_ws(' ',i.public_data->>'jurisdiction',i.public_data->>'call',i.public_data->>'location',t.label) ILIKE '%' || $3 || '%')
    ORDER BY i.received_at DESC LIMIT $4 OFFSET $5`, [status ?? null, talkgroup ?? null, q ?? null, limit, offset]);
    const incidents = ['Admin', 'Reviewer'].includes(request.user.role) ? result.rows : result.rows.map(row => ({ ...row, publish_error: null }));
    return { incidents, limit, offset };
});
app.get('/api/incidents/:id', { preHandler: [requireRoles(...roles)] }, async (request, reply) => {
    const { id } = request.params;
    const result = await query('SELECT i.*,t.label AS talkgroup_label,im.name AS image_name FROM incidents i JOIN talkgroups t ON t.id=i.talkgroup_id LEFT JOIN images im ON im.id=i.image_id WHERE i.id=$1', [id]);
    const incident = result.rows[0];
    if (!incident)
        return reply.code(404).send({ error: 'Incident not found' });
    const canReview = ['Admin', 'Reviewer'].includes(request.user.role);
    const approvals = canReview ? await query('SELECT a.created_at,u.email FROM approvals a JOIN users u ON u.id=a.user_id WHERE a.incident_id=$1 ORDER BY a.created_at DESC', [id]) : { rows: [] };
    const audits = canReview ? await query('SELECT a.action,a.details,a.created_at,u.email FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.incident_id=$1 ORDER BY a.created_at DESC LIMIT 100', [id]) : { rows: [] };
    const publicIncident = {
        id: incident.id, talkgroup_id: incident.talkgroup_id, talkgroup_label: incident.talkgroup_label,
        event_type: incident.event_type, status: incident.status, received_at: incident.received_at,
        public_data: incident.public_data, image_id: incident.image_id, image_name: incident.image_name,
        facebook_post_id: incident.facebook_post_id, publish_error: canReview ? incident.publish_error : null,
        created_at: incident.created_at, updated_at: incident.updated_at,
        ...(canReview ? { transcript: incident.transcript, internal_data: incident.internal_data, source_metadata: incident.source_metadata } : {})
    };
    return {
        ...publicIncident,
        renderedPost: publicPostSchema.safeParse(incident.public_data).success ? renderOfficialPost(incident.public_data) : '',
        audioUrl: canReview && incident.playable_path ? `/api/incidents/${id}/audio` : null,
        originalUrl: canReview && incident.original_path ? `/api/incidents/${id}/original` : null,
        publicAudioUrl: incident.playable_path && incident.public_data?.sensitivity !== 'high' && ['approved', 'publish_queued', 'publish_failed', 'publish_unknown', 'published'].includes(incident.status) ? `${(process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/public/audio/${publicAudioToken(id)}` : null,
        approvals: approvals.rows, audit: audits.rows
    };
});
app.post('/api/incidents', { preHandler: [requireRoles('Admin', 'Reviewer')] }, async (request, reply) => {
    const input = z.object({ talkgroupId: z.string().min(1), publicData: publicPostSchema }).safeParse(request.body);
    if (!input.success)
        return reply.code(400).send({ error: 'Invalid manual post', details: input.error.flatten() });
    const talkgroup = await query('SELECT id FROM talkgroups WHERE id=$1 AND enabled=true', [input.data.talkgroupId]);
    if (!talkgroup.rowCount)
        return reply.code(400).send({ error: 'Select a configured talkgroup' });
    const safe = sanitizePublicPost(input.data.publicData, '', { applyPrivacyFilters: false });
    safe.suggestedImage = null;
    const id = randomUUID();
    await query(`INSERT INTO incidents(id,talkgroup_id,event_type,status,public_data,audio_token_hash,created_by)
    VALUES ($1,$2,'manual','draft',$3,$4,$5)`, [id, input.data.talkgroupId, safe, hashToken(publicAudioToken(id)), request.user.sub]);
    await audit(request.user.sub, 'incident.created_manually', id, {});
    return reply.code(201).send({ id });
});
app.post('/api/incidents/:id/audio', { preHandler: [requireRoles('Admin', 'Reviewer')] }, async (request, reply) => {
    const { id } = request.params;
    try {
        const incident = await query('SELECT id FROM incidents WHERE id=$1', [id]);
        if (!incident.rowCount)
            return reply.code(404).send({ error: 'Incident not found' });
        const part = await request.file();
        const path = await saveUpload(part, id, 'original');
        await query(`UPDATE incidents SET original_path=$2,status='processing',
      source_metadata=coalesce(source_metadata,'{}'::jsonb) || $3::jsonb,updated_at=now() WHERE id=$1`, [id, path, { audioSources: [path] }]);
        try {
            await enqueueJob('process', { type: 'process', incidentId: id }, { jobId: `process-${id}-${Date.now()}` });
        }
        catch (error) {
            app.log.error({ incidentId: id, error }, 'Manual audio stored; worker enqueue will be recovered');
        }
        await audit(request.user.sub, 'audio.uploaded', id, { bytes: part?.file.bytesRead ?? 0 });
        return reply.code(202).send({ queued: true });
    }
    catch (error) {
        request.log.error({ incidentId: id, err: error }, 'Manual audio upload failed');
        const statusCode = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
        const clientError = statusCode >= 400 && statusCode < 500;
        return reply.code(clientError ? statusCode : 500).send({ error: clientError && error instanceof Error ? error.message : 'Audio upload failed' });
    }
});
app.post('/api/incidents/:id/reprocess', { preHandler: [requireRoles('Admin', 'Reviewer')] }, async (request, reply) => {
    const { id } = request.params;
    const updated = await query(`UPDATE incidents SET status='processing',source_metadata=source_metadata - 'processingError',updated_at=now()
    WHERE id=$1 AND original_path IS NOT NULL AND status NOT IN ('published','publish_queued','rejected') RETURNING id`, [id]);
    if (!updated.rowCount)
        return reply.code(409).send({ error: 'Incident has no audio or cannot be reprocessed' });
    try {
        await enqueueJob('process', { type: 'process', incidentId: id }, { jobId: `process-${id}-${Date.now()}` });
    }
    catch (error) {
        app.log.error({ incidentId: id, error }, 'Reprocessing queued for recovery scan');
    }
    await audit(request.user.sub, 'audio.reprocess_requested', id, {});
    return reply.code(202).send({ queued: true });
});
app.get('/api/incidents/:id/audio', async (request, reply) => {
    const claim = await verifyAudioToken(request, reply);
    if (!claim)
        return;
    return sendStoredAudio(request, reply, 'playable_path');
});
app.get('/api/incidents/:id/original', async (request, reply) => {
    const claim = await verifyAudioToken(request, reply);
    if (!claim)
        return;
    if (!['Admin', 'Reviewer'].includes(claim.role))
        return reply.code(403).send({ error: 'Insufficient role' });
    return sendStoredAudio(request, reply, 'original_path');
});
async function verifyAudioToken(request, reply) {
    const token = request.query.token;
    try {
        const claim = token ? app.jwt.verify(token) : null;
        if (claim) {
            if (claim.scope !== 'audio' || !['Admin', 'Reviewer'].includes(claim.role))
                throw new Error('Invalid audio scope');
            return claim;
        }
        await request.jwtVerify();
        if (!['Admin', 'Reviewer'].includes(request.user.role))
            throw new Error('Insufficient role');
        return request.user;
    }
    catch {
        reply.code(401).send({ error: 'Valid reviewer audio access is required' });
        return null;
    }
}
async function sendStoredAudio(request, reply, column) {
    const { id } = request.params;
    const result = await query(`SELECT ${column} AS path FROM incidents WHERE id=$1`, [id]);
    const path = result.rows[0]?.path;
    if (!path)
        return reply.code(404).send({ error: 'Audio is not available' });
    const contentType = path.endsWith('.mp3') ? 'audio/mpeg' : path.endsWith('.wav') ? 'audio/wav' : path.endsWith('.m4a') ? 'audio/mp4' : 'application/octet-stream';
    return reply.type(contentType).header('Cache-Control', 'no-store').send(storage.stream(path));
}
app.get('/public/audio/:token', async (request, reply) => {
    const { token } = request.params;
    if (!/^[a-f0-9]{32}$/.test(token))
        return reply.code(404).send({ error: 'Audio not found' });
    const result = await query(`SELECT i.playable_path FROM incidents i
    WHERE i.audio_token_hash=$1 AND i.public_data->>'sensitivity' <> 'high' AND i.status IN ('approved','publish_queued','publish_failed','publish_unknown','published')
    AND EXISTS (SELECT 1 FROM approvals a WHERE a.incident_id=i.id AND a.public_snapshot=i.public_data)`, [hashToken(token)]);
    const path = result.rows[0]?.playable_path;
    if (!path)
        return reply.code(404).send({ error: 'Audio not found' });
    return reply.type('audio/mpeg').header('Cache-Control', 'private, no-store').send(storage.stream(path));
});
app.patch('/api/incidents/:id', { preHandler: [requireRoles('Admin', 'Reviewer')] }, async (request, reply) => {
    const { id } = request.params;
    const input = z.object({ publicData: publicPostSchema, imageId: z.string().uuid().nullable() }).safeParse(request.body);
    if (!input.success)
        return reply.code(400).send({ error: 'Invalid post fields', details: input.error.flatten() });
    const source = await query('SELECT transcript,event_type FROM incidents WHERE id=$1', [id]);
    if (!source.rowCount)
        return reply.code(404).send({ error: 'Incident not found' });
    const safe = sanitizePublicPost(input.data.publicData, source.rows[0].transcript ?? '', { applyPrivacyFilters: source.rows[0].event_type !== 'manual' });
    if (input.data.imageId) {
        const image = await query('SELECT id FROM images WHERE id=$1 AND enabled=true', [input.data.imageId]);
        if (!image.rowCount)
            return reply.code(400).send({ error: 'Image is not in the configured image bank' });
        const matchingName = (await query('SELECT name FROM images WHERE id=$1', [input.data.imageId])).rows[0].name;
        safe.suggestedImage = matchingName;
    }
    else
        safe.suggestedImage = null;
    const updated = await query(`UPDATE incidents SET public_data=$2,image_id=$3,status='draft',publish_error=NULL,updated_at=now()
    WHERE id=$1 AND status NOT IN ('processing','publish_queued','published','publish_unknown') RETURNING id`, [id, safe, input.data.imageId]);
    if (!updated.rowCount)
        return reply.code(409).send({ error: 'Incident cannot be edited while audio is processing or in its current state' });
    await audit(request.user.sub, 'post.edited', id, { publicData: safe, imageId: input.data.imageId });
    return { saved: true, publicData: safe };
});
app.post('/api/incidents/:id/approve', { preHandler: [requireRoles('Admin', 'Reviewer')] }, async (request, reply) => {
    const { id } = request.params;
    const result = await transaction(async (tx) => {
        const incident = await tx.query('SELECT public_data,status,image_id,playable_path,event_type,transcript FROM incidents WHERE id=$1 FOR UPDATE', [id]);
        if (!incident.rowCount || ['processing', 'published', 'publish_queued', 'rejected', 'publish_unknown'].includes(incident.rows[0].status)) {
            return { status: 409, body: { error: 'Incident cannot be approved in its current state' } };
        }
        if (!incident.rows[0].playable_path && incident.rows[0].event_type !== 'manual') {
            return { status: 409, body: { error: 'A processed, browser-playable recording is required before approval' } };
        }
        if (incident.rows[0].image_id) {
            const image = await tx.query('SELECT id FROM images WHERE id=$1 AND enabled=true', [incident.rows[0].image_id]);
            if (!image.rowCount)
                return { status: 409, body: { error: 'Selected image is no longer enabled' } };
        }
        const safe = sanitizePublicPost(incident.rows[0].public_data, incident.rows[0].transcript ?? '', { applyPrivacyFilters: incident.rows[0].event_type !== 'manual' });
        await tx.query("UPDATE incidents SET public_data=$2,status='approved',updated_at=now() WHERE id=$1", [id, safe]);
        await tx.query('INSERT INTO approvals(incident_id,user_id,public_snapshot) VALUES ($1,$2,$3)', [id, request.user.sub, safe]);
        await tx.query('INSERT INTO audit_log(user_id,action,incident_id,details) VALUES ($1,\'post.approved\',$2,$3)', [request.user.sub, id, { publicData: safe }]);
        return { status: 200, body: { approved: true } };
    });
    return reply.code(result.status).send(result.body);
});
app.post('/api/incidents/:id/reject', { preHandler: [requireRoles('Admin', 'Reviewer')] }, async (request, reply) => {
    const { id } = request.params;
    const reason = z.object({ reason: z.string().trim().max(500).default('') }).safeParse(request.body ?? {});
    if (!reason.success)
        return reply.code(400).send({ error: 'Invalid rejection reason' });
    const result = await query("UPDATE incidents SET status='rejected',updated_at=now() WHERE id=$1 AND status NOT IN ('published','publish_queued','publish_unknown') RETURNING id", [id]);
    if (!result.rowCount)
        return reply.code(409).send({ error: 'Incident cannot be rejected in its current state' });
    await audit(request.user.sub, 'post.rejected', id, { reason: reason.data.reason });
    return { rejected: true };
});
app.post('/api/incidents/:id/resolve-publication', { preHandler: [requireRoles('Admin')] }, async (request, reply) => {
    const { id } = request.params;
    const input = z.object({ facebookPostId: z.string().trim().min(1).max(200).optional(), confirmedNotPublished: z.literal(true).optional() })
        .refine(value => Boolean(value.facebookPostId) !== Boolean(value.confirmedNotPublished)).safeParse(request.body);
    if (!input.success)
        return reply.code(400).send({ error: 'Provide the Facebook post ID, or explicitly confirm that no post exists' });
    const result = await transaction(async (tx) => {
        const incident = await tx.query("SELECT status FROM incidents WHERE id=$1 FOR UPDATE", [id]);
        if (!incident.rowCount || incident.rows[0].status !== 'publish_unknown') {
            return { status: 409, body: { error: 'Incident is not awaiting publication reconciliation' } };
        }
        if (input.data.facebookPostId) {
            await tx.query("UPDATE incidents SET status='published',facebook_post_id=$2,publish_error=NULL,updated_at=now() WHERE id=$1", [id, input.data.facebookPostId]);
            await tx.query("UPDATE publish_jobs SET status='published',facebook_post_id=$2,error=NULL,updated_at=now() WHERE incident_id=$1", [id, input.data.facebookPostId]);
            await tx.query("INSERT INTO audit_log(user_id,action,incident_id,details) VALUES ($1,'publish.reconciled_as_published',$2,$3)", [request.user.sub, id, { facebookPostId: input.data.facebookPostId }]);
        }
        else {
            await tx.query("UPDATE incidents SET status='publish_failed',publish_error=NULL,updated_at=now() WHERE id=$1", [id]);
            await tx.query("UPDATE publish_jobs SET status='failed',error='Admin confirmed no Facebook post exists',updated_at=now() WHERE incident_id=$1", [id]);
            await tx.query("INSERT INTO audit_log(user_id,action,incident_id,details) VALUES ($1,'publish.reconciled_as_not_published',$2,'{}')", [request.user.sub, id]);
        }
        return { status: 200, body: { reconciled: true, publicationStatus: input.data.facebookPostId ? 'published' : 'publish_failed' } };
    });
    return reply.code(result.status).send(result.body);
});
app.post('/api/incidents/:id/publish', { preHandler: [requireRoles('Admin', 'Reviewer')] }, async (request, reply) => {
    const { id } = request.params;
    const result = await transaction(async (tx) => {
        const incident = await tx.query("SELECT status FROM incidents WHERE id=$1 FOR UPDATE", [id]);
        if (!incident.rowCount || !['approved', 'publish_failed'].includes(incident.rows[0].status)) {
            return { status: 409, body: { error: 'A current human approval is required before publishing' } };
        }
        const approval = await tx.query('SELECT id FROM approvals WHERE incident_id=$1 ORDER BY created_at DESC LIMIT 1', [id]);
        if (!approval.rowCount)
            return { status: 403, body: { error: 'Human approval record not found' } };
        await tx.query("UPDATE incidents SET status='publish_queued',publish_error=NULL,updated_at=now() WHERE id=$1", [id]);
        await tx.query(`INSERT INTO publish_jobs(incident_id,status,attempts) VALUES ($1,'queued',0)
      ON CONFLICT (incident_id) DO UPDATE SET status='queued',error=NULL,updated_at=now() WHERE publish_jobs.status <> 'published'`, [id]);
        await tx.query('INSERT INTO audit_log(user_id,action,incident_id,details) VALUES ($1,\'publish.queued\',$2,\'{}\')', [request.user.sub, id]);
        return { status: 202, body: { queued: true } };
    });
    if (result.status !== 202)
        return reply.code(result.status).send(result.body);
    try {
        await enqueueJob('publish', { type: 'publish', incidentId: id }, { jobId: `publish-${id}-${Date.now()}`, attempts: 1 });
    }
    catch (error) {
        app.log.error({ incidentId: id, error }, 'Publication remains queued in embedded storage for worker pickup');
    }
    return reply.code(202).send(result.body);
});
app.get('/api/radio-keys', { preHandler: [requireRoles('Admin')] }, async () => ({
    keys: (await query('SELECT id,name,system_id,talkgroup_ids,enabled,created_at,last_used_at FROM radio_api_keys ORDER BY created_at DESC')).rows
}));
app.post('/api/radio-keys', { preHandler: [requireRoles('Admin')] }, async (request, reply) => {
    const input = z.object({ name: z.string().trim().min(1).max(100), systemId: z.string().trim().regex(/^\d+$/).max(50), talkgroupIds: z.array(z.string().min(1).max(100)).min(1).max(100) }).safeParse(request.body);
    if (!input.success)
        return reply.code(400).send({ error: 'Name, system ID, and at least one talkgroup are required' });
    const talkgroupIds = [...new Set(input.data.talkgroupIds)];
    const configured = await query('SELECT id FROM talkgroups WHERE enabled=true AND id=ANY($1::text[])', [talkgroupIds]);
    if (configured.rowCount !== talkgroupIds.length)
        return reply.code(400).send({ error: 'Keys can only include enabled configured talkgroups' });
    const apiKey = `rdio_${randomBytes(32).toString('base64url')}`;
    const result = await query(`INSERT INTO radio_api_keys(name,key_hash,system_id,talkgroup_ids,created_by)
    VALUES ($1,$2,$3,$4,$5) RETURNING id`, [input.data.name, hashToken(apiKey), input.data.systemId, talkgroupIds, request.user.sub]);
    await audit(request.user.sub, 'radio_api_key.created', null, { keyId: result.rows[0].id, name: input.data.name, systemId: input.data.systemId, talkgroupIds });
    return reply.code(201).send({ id: result.rows[0].id, apiKey, name: input.data.name, systemId: input.data.systemId, talkgroupIds });
});
app.delete('/api/radio-keys/:id', { preHandler: [requireRoles('Admin')] }, async (request, reply) => {
    const { id } = request.params;
    const result = await query('UPDATE radio_api_keys SET enabled=false WHERE id=$1 AND enabled=true RETURNING name,system_id,talkgroup_ids', [id]);
    if (!result.rowCount)
        return reply.code(404).send({ error: 'Active radio key not found' });
    await audit(request.user.sub, 'radio_api_key.revoked', null, { keyId: id, ...result.rows[0] });
    return { revoked: true };
});
app.get('/api/talkgroups', { preHandler: [requireRoles(...roles)] }, async () => ({ talkgroups: (await query('SELECT * FROM talkgroups ORDER BY label')).rows }));
app.post('/api/talkgroups', { preHandler: [requireRoles('Admin')] }, async (request, reply) => {
    const input = z.object({ id: z.string().trim().min(1).max(100), label: z.string().trim().min(1).max(120), enabled: z.boolean().default(true) }).safeParse(request.body);
    if (!input.success)
        return reply.code(400).send({ error: 'Invalid talkgroup' });
    await query('INSERT INTO talkgroups(id,label,enabled) VALUES ($1,$2,$3) ON CONFLICT(id) DO UPDATE SET label=$2,enabled=$3', [input.data.id, input.data.label, input.data.enabled]);
    await audit(request.user.sub, 'talkgroup.saved', null, input.data);
    return reply.code(201).send({ saved: true });
});
app.get('/api/images', { preHandler: [requireRoles(...roles)] }, async () => ({ images: (await query('SELECT id,name,location,enabled FROM images ORDER BY location,name')).rows }));
app.get('/api/images/:id/file', { preHandler: [requireRoles(...roles)] }, async (request, reply) => {
    const { id } = request.params;
    const result = await query('SELECT path FROM images WHERE id=$1 AND enabled=true', [id]);
    if (!result.rows[0])
        return reply.code(404).send({ error: 'Image not found' });
    const path = result.rows[0].path;
    const type = path.endsWith('.png') ? 'image/png' : path.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    return reply.type(type).send(storage.stream(path));
});
app.patch('/api/images/:id', { preHandler: [requireRoles('Admin')] }, async (request, reply) => {
    const { id } = request.params;
    const input = z.object({ enabled: z.boolean() }).safeParse(request.body);
    if (!input.success)
        return reply.code(400).send({ error: 'An enabled state is required' });
    const result = await query('UPDATE images SET enabled=$2 WHERE id=$1 RETURNING id', [id, input.data.enabled]);
    if (!result.rowCount)
        return reply.code(404).send({ error: 'Image not found' });
    await audit(request.user.sub, input.data.enabled ? 'image.enabled' : 'image.disabled', null, { imageId: id });
    return { saved: true };
});
app.post('/api/images', { preHandler: [requireRoles('Admin')] }, async (request, reply) => {
    const fields = {};
    let part = undefined;
    let imageBytes = null;
    for await (const item of request.parts({ limits: { fileSize: 10 * 1024 * 1024, files: 1 } })) {
        if (item.type === 'file') {
            part = item;
            imageBytes = await item.toBuffer();
        }
        else
            fields[item.fieldname] = String(item.value ?? '');
    }
    const valid = z.object({ name: z.string().trim().min(1).max(100), location: z.string().trim().min(1).max(100) }).safeParse(fields);
    if (!valid.success || !part || !imageBytes)
        return reply.code(400).send({ error: 'Image, name, and location are required' });
    const uploadedImage = imageBytes;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(part.mimetype))
        return reply.code(400).send({ error: 'Use PNG, JPEG, or WebP images' });
    const validSignature = part.mimetype === 'image/png' ? imageBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : part.mimetype === 'image/jpeg' ? imageBytes[0] === 255 && imageBytes[1] === 216 && imageBytes[2] === 255
            : imageBytes.toString('ascii', 0, 4) === 'RIFF' && imageBytes.toString('ascii', 8, 12) === 'WEBP';
    if (!validSignature)
        return reply.code(400).send({ error: 'Image content does not match its file type' });
    const id = randomUUID();
    const extension = part.mimetype === 'image/png' ? '.png' : part.mimetype === 'image/webp' ? '.webp' : '.jpg';
    const path = `image-${id}${extension}`;
    await storage.putBuffer(path, uploadedImage);
    await query('INSERT INTO images(id,name,location,path) VALUES ($1,$2,$3,$4)', [id, valid.data.name, valid.data.location, path]);
    await audit(request.user.sub, 'image.added', null, { name: valid.data.name, location: valid.data.location });
    return reply.code(201).send({ id });
});
app.get('/api/audit', { preHandler: [requireRoles('Admin')] }, async (request) => {
    const { limit = '100' } = request.query;
    const safeLimit = Math.min(500, Math.max(1, Number.parseInt(limit, 10) || 100));
    return { entries: (await query('SELECT a.*,u.email FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT $1', [safeLimit])).rows };
});
await runMigrations();
await bootstrapAdmin();
startWorker();
const webRoot = resolve(fileURLToPath(new URL('../../web/dist', import.meta.url)));
if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith('/api/') || request.url.startsWith('/public/'))
            return reply.code(404).send({ error: 'Not found' });
        return reply.sendFile('index.html');
    });
}
const port = Number(process.env.PORT ?? 3000);
await app.listen({ host: '0.0.0.0', port });
for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, async () => {
        stopWorker();
        await app.close();
        await closeDatabase();
        process.exit(0);
    });
