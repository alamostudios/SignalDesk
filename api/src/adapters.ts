import { z } from 'zod';
import { publicPostSchema, type PublicPost } from './types.js';

export interface Transcriber { transcribe(audio: Buffer): Promise<string> }
export interface Reasoner { extract(transcript: string, receivedAt: Date, locations: string[]): Promise<PublicPost & { exactAddress?: string }> }
export interface ImageAsset { name: string; mimeType: 'image/png'|'image/jpeg'|'image/webp'; data: Buffer }
export interface FacebookPublisher { validateConfiguration(): void; publish(message: string, audioUrl?: string, image?: ImageAsset): Promise<string> }

export class PublicationUncertainError extends Error {
  constructor(message: string) { super(message); this.name = 'PublicationUncertainError'; }
}

export class PublicationRejectedError extends Error {
  constructor(message: string) { super(message); this.name = 'PublicationRejectedError'; }
}

export class PublicationClaimedError extends Error {
  constructor(message: string) { super(message); this.name = 'PublicationClaimedError'; }
}

export class OpenAICompatibleWhisper implements Transcriber {
  async transcribe(audio: Buffer): Promise<string> {
    const baseUrl = process.env.WHISPER_BASE_URL;
    if (!baseUrl) throw new Error('WHISPER_BASE_URL is not configured');
    const form = new FormData();
    form.append('file', new Blob([Uint8Array.from(audio)]), 'incident.mp3');
    form.append('model', process.env.WHISPER_MODEL ?? 'whisper-1');
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
      method: 'POST', headers: process.env.WHISPER_API_KEY ? { Authorization: `Bearer ${process.env.WHISPER_API_KEY}` } : {}, body: form, signal: AbortSignal.timeout(120_000)
    });
    if (!response.ok) throw new Error(`Transcription provider returned ${response.status}`);
    const result = z.object({ text: z.string() }).parse(await response.json());
    return result.text;
  }
}

const extractionSchema = publicPostSchema.omit({ timeReceived: true }).extend({ timeReceived: z.string().max(40), exactAddress: z.string().optional() }).strict();

export class OpenAICompatibleReasoner implements Reasoner {
  async extract(transcript: string, receivedAt: Date, locations: string[]): Promise<PublicPost & { exactAddress?: string }> {
    const baseUrl = process.env.AI_BASE_URL;
    if (!baseUrl) throw new Error('AI_BASE_URL is not configured');
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(process.env.AI_API_KEY ? { Authorization: `Bearer ${process.env.AI_API_KEY}` } : {}) },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: process.env.AI_MODEL ?? 'qwen2.5:7b', temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `Extract incident information as one JSON object with exactly these fields: jurisdiction, call, location, extraInfo, timeReceived, sensitivity, suggestedImage, exactAddress. sensitivity must be low, moderate, or high. Never include names, phone numbers, medical details, or other PII. Treat suicide, medical, domestic-violence, child-related, and ambiguous sensitive calls as high sensitivity. Generalize addresses to a 1200 block or intersection in location; exactAddress is internal only. Do not speculate or invent. Suggested image must be one of: ${locations.join(', ') || 'null'}. timeReceived can be an empty string; the application will set the official local time.` },
          { role: 'user', content: `Received at ${receivedAt.toISOString()}. Transcript:\n${transcript}` }
        ]
      })
    });
    if (!response.ok) throw new Error(`Reasoning provider returned ${response.status}`);
    const result = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1) }).parse(await response.json());
    const json = JSON.parse(result.choices[0]!.message.content) as unknown;
    return extractionSchema.parse(json);
  }
}

export class MetaGraphPublisher implements FacebookPublisher {
  validateConfiguration() {
    if (!process.env.FACEBOOK_PAGE_ID || !process.env.FACEBOOK_ACCESS_TOKEN) throw new Error('Facebook publisher credentials are not configured');
    if (process.env.FACEBOOK_GRAPH_VERSION && !/^v\d+\.\d+$/.test(process.env.FACEBOOK_GRAPH_VERSION)) throw new Error('FACEBOOK_GRAPH_VERSION must look like v23.0');
  }

  async publish(message: string, audioUrl?: string, image?: ImageAsset): Promise<string> {
    this.validateConfiguration();
    const pageId = process.env.FACEBOOK_PAGE_ID;
    const token = process.env.FACEBOOK_ACCESS_TOKEN;
    if (!pageId || !token) throw new Error('Facebook publisher credentials are not configured');
    const version = process.env.FACEBOOK_GRAPH_VERSION ?? 'v23.0';
    let attachedMedia: string | undefined;
    if (image) {
      const form = new FormData();
      const extension = image.mimeType === 'image/png' ? '.png' : image.mimeType === 'image/webp' ? '.webp' : '.jpg';
      const filename = (image.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 76) || 'location-image') + extension;
      form.append('source', new Blob([Uint8Array.from(image.data)], { type: image.mimeType }), filename);
      form.append('published', 'false');
      form.append('access_token', token);
      const photoResponse = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(pageId)}/photos`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) });
      const photo = await photoResponse.json() as { id?: string; error?: { message?: string } };
      if (!photoResponse.ok || !photo.id) throw new Error(photo.error?.message ?? `Facebook image upload returned ${photoResponse.status}`);
      attachedMedia = JSON.stringify([{ media_fbid: photo.id }]);
    }
    const fields = new URLSearchParams({ message, access_token: token });
    if (audioUrl) fields.set('link', audioUrl);
    if (attachedMedia) fields.set('attached_media', attachedMedia);
    let response: Response;
    try { response = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(pageId)}/feed`, { method: 'POST', body: fields, signal: AbortSignal.timeout(30_000) }); }
    catch { throw new PublicationUncertainError('Facebook feed request timed out or disconnected; verify the Page before retrying'); }
    let data: { id?: string; error?: { message?: string } };
    try { data = await response.json() as { id?: string; error?: { message?: string } }; }
    catch { throw new PublicationUncertainError('Facebook returned an unreadable response; verify the Page before retrying'); }
    if (response.status >= 500) throw new PublicationUncertainError(data.error?.message ?? `Facebook returned ${response.status}; verify the Page before retrying`);
    if (!response.ok) throw new PublicationRejectedError(data.error?.message ?? `Facebook returned ${response.status}`);
    if (!data.id) throw new PublicationUncertainError('Facebook response contained no post ID; verify the Page before retrying');
    return data.id;
  }
}