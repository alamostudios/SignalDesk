export type ToneResult = { detected: boolean; frequencies: number[]; durationMs: number };

export function detectConfiguredTones(pcm: Buffer, sampleRate: number, frequencies: number[], threshold = 0.18): ToneResult {
  const frameSize = Math.floor(sampleRate / 10);
  const matched = new Set<number>();
  let matchingFrames = 0;
  let totalFrames = 0;
  for (let offset = 0; offset + frameSize * 2 <= pcm.length; offset += frameSize * 2) {
    totalFrames++;
    const samples = new Float64Array(frameSize);
    let energy = 0;
    for (let i = 0; i < frameSize; i++) {
      samples[i] = pcm.readInt16LE(offset + i * 2) / 32768;
      energy += samples[i]! * samples[i]!;
    }
    if (energy / frameSize < 0.002) continue;
    const powers = frequencies.map(frequency => ({ frequency, power: goertzel(samples, sampleRate, frequency) }));
    const peak = Math.max(0, ...powers.map(item => item.power));
    const frameHits = powers.filter(item => item.power > peak * threshold && item.power > 0.005);
    if (frameHits.length) {
      matchingFrames++;
      for (const hit of frameHits) matched.add(hit.frequency);
    }
  }
  const durationMs = Math.round(matchingFrames * 100);
  return { detected: matched.size > 0 && durationMs >= 300 && totalFrames > 0, frequencies: [...matched], durationMs };
}

function goertzel(samples: Float64Array, sampleRate: number, frequency: number): number {
  const coefficient = 2 * Math.cos(2 * Math.PI * frequency / sampleRate);
  let previous = 0;
  let previous2 = 0;
  for (const sample of samples) {
    const current = sample + coefficient * previous - previous2;
    previous2 = previous;
    previous = current;
  }
  return Math.max(0, previous2 * previous2 + previous * previous - coefficient * previous * previous2) / (samples.length * samples.length);
}