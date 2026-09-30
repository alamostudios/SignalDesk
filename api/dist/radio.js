import { z } from 'zod';
export const radioEventSchema = z.object({
    externalId: z.string().max(200).optional(),
    talkgroupId: z.string().min(1).max(100),
    eventType: z.enum(['tone', 'dispatch']).default('dispatch'),
    receivedAt: z.coerce.date().optional(),
    audioBase64: z.string().max(90_000_000).optional(),
    audioMime: z.string().max(100).optional(),
    metadata: z.record(z.unknown()).default({})
});
export class JsonWebhookRadioAdapter {
    normalize(payload) { return radioEventSchema.safeParse(payload); }
}
export const radioSource = new JsonWebhookRadioAdapter();
