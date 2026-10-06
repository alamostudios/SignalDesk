const highPriorityPatterns = [
    /\b10[\s-]*50\b/i,
    /\broll[\s-]*over\b/i,
    /\b10[\s-]*0\b/i,
    /\bcrash\s+detection\b/i
];
const mediumPriorityPatterns = [
    /\brequest(?:ing)?\s+(?:(?:that|you)\s+){0,2}(?:you\s+)?be\s+en\s+route\b/i,
    /\bto\s+the\s+area\s+of\b/i,
    /\bC\.?P\.?(?:\s+advises)?\b/i
];
export function suggestPriority(transcript) {
    if (highPriorityPatterns.some(pattern => pattern.test(transcript)))
        return 'high';
    if (mediumPriorityPatterns.some(pattern => pattern.test(transcript)))
        return 'medium';
    return 'low';
}
export function suggestCall(transcript) {
    if (/\b10[\s-]*50\b.{0,24}\broll[\s-]*over\b|\broll[\s-]*over\b.{0,24}\b10[\s-]*50\b/i.test(transcript))
        return '10-50 rollover';
    if (/\b10[\s-]*50\b/i.test(transcript))
        return '10-50';
    if (/\broll[\s-]*over\b/i.test(transcript))
        return 'Rollover';
    if (/\b10[\s-]*0\b/i.test(transcript))
        return '10-0';
    if (/\bcrash\s+detection\b/i.test(transcript))
        return 'Crash detection';
    if (/\bC\.?P\.?\s+advises\b/i.test(transcript))
        return 'CP advises';
    if (/\brequest(?:ing)?\s+(?:(?:that|you)\s+){0,2}(?:you\s+)?be\s+en\s+route\b/i.test(transcript))
        return 'Request for units en route';
    if (/\bto\s+the\s+area\s+of\b/i.test(transcript))
        return 'Request to area';
    return null;
}
