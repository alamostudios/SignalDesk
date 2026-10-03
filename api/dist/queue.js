import { randomUUID } from 'node:crypto';
import { query, transaction } from './db.js';
let wakeListener;
export let workerOnline = false;
export function onWorkerWake(listener) { wakeListener = listener; }
export function setWorkerOnline(online) { workerOnline = online; }
export async function enqueueJob(name, payload, options = {}) {
    const key = options.jobId ?? randomUUID();
    await query(`INSERT INTO background_jobs(job_key,job_type,payload,max_attempts)
		VALUES ($1,$2,$3,$4) ON CONFLICT(job_key) DO NOTHING`, [key, payload.type, payload, options.attempts ?? (payload.type === 'publish' ? 1 : 4)]);
    wakeListener?.();
}
export async function claimNextJob() {
    return transaction(async (tx) => {
        const result = await tx.query(`SELECT id,job_key,payload,attempts,max_attempts FROM background_jobs
			WHERE status='queued' AND run_after <= now() ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
        const job = result.rows[0];
        if (!job)
            return null;
        await tx.query("UPDATE background_jobs SET status='processing',attempts=attempts+1,updated_at=now() WHERE id=$1", [job.id]);
        return { id: job.id, key: job.job_key, payload: job.payload, attempts: job.attempts + 1, maxAttempts: job.max_attempts };
    });
}
export async function completeJob(jobId) {
    await query("UPDATE background_jobs SET status='complete',last_error=NULL,updated_at=now() WHERE id=$1", [jobId]);
}
export async function failJob(job, error, retryDelayMs = 3000) {
    const canRetry = job.attempts < job.maxAttempts && job.payload.type === 'process';
    await query(`UPDATE background_jobs SET status=$2,last_error=$3,
		run_after=CASE WHEN $2='queued' THEN now() + ($4::int * interval '1 millisecond') ELSE run_after END,
		updated_at=now() WHERE id=$1`, [job.id, canRetry ? 'queued' : 'failed', error.slice(0, 500), retryDelayMs]);
}
