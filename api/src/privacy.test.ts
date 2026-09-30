import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generalizeAddress, sanitizePublicPost } from './privacy.js';
import { hasMatchingApproval, publicPostSchema, renderOfficialPost } from './types.js';
import { detectConfiguredTones } from './tones.js';

const sample = {
  jurisdiction: 'Fulton County', call: '10-50 Rollover', location: '123 Main Street',
  extraInfo: '', timeReceived: '05:27 hrs', sensitivity: 'low', suggestedImage: null
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