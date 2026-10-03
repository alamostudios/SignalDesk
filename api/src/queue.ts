import { randomUUID } from 'node:crypto';
import { query, transaction } from './db.js';

export type WorkType = 'process' | 'publish';
export type WorkPayload = { type: WorkType; incidentId: string };
export type WorkJob = { id: string; key: string; payload: WorkPayload; attempts: number; maxAttempts: number };

let wakeListener: (() => void) | undefined;
export let workerOnline = false;

export function onWorkerWake(listener: () => void) { wakeListener = listener; }
export function setWorkerOnline(online: boolean) { workerOnline = online; }

export async function enqueueJob(name: string, payload: WorkPayload, options: { jobId?: string; attempts?: number } = {}) {
	const key = options.jobId ?? randomUUID();
	await query(`INSERT INTO background_jobs(job_key,job_type,payload,max_attempts)
		VALUES ($1,$2,$3,$4) ON CONFLICT(job_key) DO NOTHING`, [key, payload.type, payload, options.attempts ?? (payload.type === 'publish' ? 1 : 4)]);
	wakeListener?.();
}

export async function claimNextJob(): Promise<WorkJob | null> {
	return transaction(async tx => {
		const result = await tx.query<{ id: string; job_key: string; payload: WorkPayload; attempts: number; max_attempts: number }>(`SELECT id,job_key,payload,attempts,max_attempts FROM background_jobs
			WHERE status='queued' AND run_after <= now() ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
		const job = result.rows[0];
		if (!job) return null;
		await tx.query("UPDATE background_jobs SET status='processing',attempts=attempts+1,updated_at=now() WHERE id=$1", [job.id]);
		return { id: job.id, key: job.job_key, payload: job.payload, attempts: job.attempts + 1, maxAttempts: job.max_attempts };
	});
}

export async function completeJob(jobId: string) {
	await query("UPDATE background_jobs SET status='complete',last_error=NULL,updated_at=now() WHERE id=$1", [jobId]);
}

export async function failJob(job: WorkJob, error: string, retryDelayMs = 3000) {
	const canRetry = job.attempts < job.maxAttempts && job.payload.type === 'process';
	await query(`UPDATE background_jobs SET status=$2,last_error=$3,
		run_after=CASE WHEN $2='queued' THEN now() + ($4::int * interval '1 millisecond') ELSE run_after END,
		updated_at=now() WHERE id=$1`, [job.id, canRetry ? 'queued' : 'failed', error.slice(0, 500), retryDelayMs]);
}