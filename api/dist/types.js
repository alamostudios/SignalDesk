import { z } from 'zod';
export const publicPostSchema = z.object({
    jurisdiction: z.string().trim().min(1).max(80),
    call: z.string().trim().min(1).max(100),
    location: z.string().trim().max(120),
    extraInfo: z.string().trim().max(160).default(''),
    timeReceived: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d hrs$/),
    includeAudio: z.boolean().default(true),
    sensitivity: z.enum(['low', 'moderate', 'high']),
    suggestedImage: z.string().nullable().default(null)
}).strict();
export function renderOfficialPost(data) {
    const jurisdiction = data.jurisdiction.toLocaleUpperCase('en-US');
    const incidentLines = [data.call, data.extraInfo, data.location].filter(Boolean).join('\n');
    return `${jurisdiction} -\n\n${incidentLines}\n(${data.timeReceived})`;
}
export function hasMatchingApproval(publicData, approvedSnapshot) {
    const current = publicPostSchema.safeParse(publicData);
    const approved = publicPostSchema.safeParse(approvedSnapshot);
    return current.success && approved.success && JSON.stringify(current.data) === JSON.stringify(approved.data);
}
