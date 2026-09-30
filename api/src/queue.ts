import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
export const queue = new Queue('rdio-work', { connection: redis, defaultJobOptions: { attempts: 4, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: 500, removeOnFail: 1000 } });