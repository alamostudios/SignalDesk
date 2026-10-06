import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generalizeAddress, sanitizePublicPost } from './privacy.js';
import { hasMatchingApproval, publicPostSchema, renderOfficialPost } from './types.js';
import { detectConfiguredTones } from './tones.js';
import { suggestCall, suggestPriority } from './priorities.js';
import { OpenAICompatibleWhisper } from './adapters.js';
const sample = {
    jurisdiction: 'Fulton County', call: '10-50 Rollover', location: '123 Main Street',
    extraInfo: '', timeReceived: '05:27 hrs', includeAudio: true, sensitivity: 'low', suggestedImage: null
};
test('generalizes exact street addresses', () => {
    assert.equal(generalizeAddress('123 Main Street'), '1200 block of Main Street');
    assert.equal(generalizeAddress('123 Main Street, Apt 4B'), '1200 block of Main Street');
});
test('strips contact details and applies conservative sensitivity handling', () => {
    const result = sanitizePublicPost({ ...sample, extraInfo: 'Call Jane at 555-212-9898; possible medical emergency' });
    assert.equal(result.sensitivity, 'high');
    assert.equal(result.call, 'Sensitive incident');
    assert.equal(result.extraInfo, '');
    assert.equal(result.location, '');
    assert.doesNotMatch(JSON.stringify(result), /Jane|555-212-9898|medical/i);
});
test('redacts probable names and generalizes addresses outside the location field', () => {
    const result = sanitizePublicPost({ ...sample, call: 'John Smith at 42 Oak Road', location: 'Jane Doe at 42 Oak Road', extraInfo: 'Caller: Jane Doe, callback 555-212-9898' });
    assert.equal(result.call, 'at 1200 block of Oak Road');
    assert.equal(result.location, 'at 1200 block of Oak Road');
    assert.equal(result.extraInfo, '');
    assert.doesNotMatch(JSON.stringify(result), /John Smith|Jane Doe|42 Oak Road|555-212-9898/);
});
test('post renderer uses fixed format and never injects labels or narrative', () => {
    const result = renderOfficialPost(sanitizePublicPost(sample));
    assert.equal(result, 'FULTON COUNTY -\n\n10-50 Rollover\n1200 block of Main Street\n(05:27 hrs)');
});
test('detects configured page-tone frequency and ignores an unmatched frequency', () => {
    const sampleRate = 8000;
    const pcm = Buffer.alloc(sampleRate * 2);
    for (let index = 0; index < sampleRate; index++) {
        pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 1000 * index / sampleRate) * 12000), index * 2);
    }
    assert.equal(detectConfiguredTones(pcm, sampleRate, [1000, 1500]).detected, true);
    assert.equal(detectConfiguredTones(pcm, sampleRate, [1500]).detected, false);
});
test('publisher approval gate rejects changed or malformed public content', () => {
    const approved = sanitizePublicPost(sample);
    assert.equal(hasMatchingApproval(approved, approved), true);
    assert.equal(hasMatchingApproval({ ...approved, call: 'Edited after approval' }, approved), false);
    assert.equal(hasMatchingApproval({ ...approved, unexpected: 'free text' }, approved), false);
});
test('time field only accepts the official 24-hour format', () => {
    assert.equal(publicPostSchema.safeParse(sample).success, true);
    assert.equal(publicPostSchema.safeParse({ ...sample, timeReceived: 'around five thirty' }).success, false);
});
test('sensitive transcript context overrides a low-risk structured extraction', () => {
    const result = sanitizePublicPost(sample, 'Responding to a possible suicide attempt');
    assert.equal(result.sensitivity, 'high');
    assert.equal(result.call, 'Sensitive incident');
    assert.equal(result.location, '');
});
test('preserves an administrative jurisdiction and removes a name appended to it', () => {
    const result = sanitizePublicPost({ ...sample, jurisdiction: 'Fulton County Jane Doe' });
    assert.equal(result.jurisdiction, 'Fulton County');
    assert.doesNotMatch(JSON.stringify(result), /Jane Doe/);
});
test('uses safe required-field labels when privacy redaction removes all content', () => {
    const result = sanitizePublicPost({ ...sample, jurisdiction: 'Jane Doe', call: 'John Smith' });
    assert.equal(result.jurisdiction, 'Jurisdiction withheld');
    assert.equal(result.call, 'Details withheld');
    assert.equal(publicPostSchema.safeParse(result).success, true);
    assert.doesNotMatch(JSON.stringify(result), /Jane Doe|John Smith/);
});
test('manual posts can bypass privacy filters while schema validation remains active', () => {
    const manualPost = {
        ...sample,
        jurisdiction: 'Jane Doe County',
        call: 'John Smith at 42 Oak Road',
        location: '123 Main Street',
        extraInfo: 'Call Jane at 555-212-9898'
    };
    const result = sanitizePublicPost(manualPost, '', { applyPrivacyFilters: false });
    assert.deepEqual(result, manualPost);
    assert.equal(publicPostSchema.safeParse(result).success, true);
});
test('audio sharing preference is retained and changes the approval snapshot', () => {
    const withAudio = sanitizePublicPost(sample);
    const withoutAudio = sanitizePublicPost({ ...sample, includeAudio: false });
    assert.equal(withAudio.includeAudio, true);
    assert.equal(withoutAudio.includeAudio, false);
    assert.equal(hasMatchingApproval(withoutAudio, withAudio), false);
});
test('suggests high internal priority for urgent call phrases', () => {
    for (const phrase of ['10-50 rollover', 'roll over', '10-0', 'crash detection']) {
        assert.equal(suggestPriority(`Dispatch reports ${phrase}`), 'high', phrase);
    }
});
test('suggests medium internal priority for response requests', () => {
    for (const phrase of ['Request you be en route', 'to the area of Oak and Main', 'CP', 'CP Advises units are needed']) {
        assert.equal(suggestPriority(phrase), 'medium', phrase);
    }
});
test('defaults unmatched or missing transcript to low priority and high takes precedence', () => {
    assert.equal(suggestPriority('Routine traffic, no assistance needed'), 'low');
    assert.equal(suggestPriority(''), 'low');
    assert.equal(suggestPriority('CP advises possible 10-50'), 'high');
});
test('suggests concise call titles from transcript phrases without inventing other fields', () => {
    assert.equal(suggestCall('Traffic advises a 10-50 rollover on Main'), '10-50 rollover');
    assert.equal(suggestCall('CP advises units are needed'), 'CP advises');
    assert.equal(suggestCall('Routine radio check'), null);
});
test('sends audio to the configured whisper.cpp inference endpoint', async () => {
    const previousBase = process.env.WHISPER_BASE_URL;
    const previousPath = process.env.WHISPER_API_PATH;
    const previousFetch = globalThis.fetch;
    process.env.WHISPER_BASE_URL = 'http://whisper.local:8080';
    process.env.WHISPER_API_PATH = '/inference';
    globalThis.fetch = async (input, init) => {
        assert.equal(String(input), 'http://whisper.local:8080/inference');
        const form = init?.body;
        assert.equal(form.get('response_format'), 'json');
        assert.equal(form.get('temperature'), '0');
        assert.equal(form.get('model'), null);
        return new Response(JSON.stringify({ text: 'Request you be en route' }), { status: 200 });
    };
    try {
        assert.equal(await new OpenAICompatibleWhisper().transcribe(Buffer.from('audio')), 'Request you be en route');
    }
    finally {
        globalThis.fetch = previousFetch;
        if (previousBase === undefined)
            delete process.env.WHISPER_BASE_URL;
        else
            process.env.WHISPER_BASE_URL = previousBase;
        if (previousPath === undefined)
            delete process.env.WHISPER_API_PATH;
        else
            process.env.WHISPER_API_PATH = previousPath;
    }
});
