import { z } from 'zod';

export const radioEventSchema = z.object({
  externalId: z.string().max(200).optional(),
  talkgroupId: z.string().min(1).max(100),
  eventType: z.enum(['tone','dispatch']).default('dispatch'),
  receivedAt: z.coerce.date().optional(),
  audioBase64: z.string().max(90_000_000).optional(),
  audioMime: z.string().max(100).optional(),
  metadata: z.record(z.unknown()).default({})
});

export type RadioEvent = z.infer<typeof radioEventSchema>;

export interface RadioSourceAdapter {
  normalize(payload: unknown): ReturnType<typeof radioEventSchema.safeParse>;
}

export class JsonWebhookRadioAdapter implements RadioSourceAdapter {
  normalize(payload: unknown) { return radioEventSchema.safeParse(payload); }
}

export const radioSource: RadioSourceAdapter = new JsonWebhookRadioAdapter();