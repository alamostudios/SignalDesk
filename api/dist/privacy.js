import { publicPostSchema } from './types.js';
const blockedSensitivity = /\b(suicid(?:e|al)|medical|patient|injur(?:y|ies|ed)|overdose|unresponsive|unconscious|ambulance|medic|hospital|heart attack|stroke|seizure|chest pain|cardiac|breathing problem|domestic[\s-]+violence|child|juvenile|sexual[\s-]+assault|self[\s-]+harm|mental[\s-]+health|abuse|rape|pregnan(?:t|cy)|bleeding|trauma|death|deceased|fatal(?:ity)?)\b/i;
const phonePattern = /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/g;
const streetAddressPattern = /\b\d{1,6}\s+(?:[\w.'-]+\s+){0,4}(?:street|st\.?|road|rd\.?|avenue|ave\.?|drive|dr\.?|lane|ln\.?|court|ct\.?|boulevard|blvd\.?|highway|hwy\.?|way)\b/gi;
const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const probableNamePattern = /\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}\b/g;
const jurisdictionMarkerPattern = /^(.+\b(?:county|parish|city|township|town|village|borough|state|district)\b)(.*)$/i;
export function sanitizePublicPost(value, contextText = '', options = {}) {
    const candidate = publicPostSchema.parse(value);
    if (options.applyPrivacyFilters === false)
        return candidate;
    if (blockedSensitivity.test(`${candidate.call} ${candidate.extraInfo} ${contextText}`)) {
        candidate.sensitivity = 'high';
        candidate.call = 'Sensitive incident';
        candidate.extraInfo = '';
        candidate.location = generalizeAddress(candidate.location);
    }
    const jurisdictionText = cleanText(candidate.jurisdiction);
    candidate.jurisdiction = sanitizeJurisdiction(jurisdictionText) || 'Jurisdiction withheld';
    candidate.call = generalizeAddress(redactLikelyNames(cleanText(candidate.call)));
    if (!candidate.call)
        candidate.call = candidate.sensitivity === 'high' ? 'Sensitive incident' : 'Details withheld';
    candidate.location = generalizeAddress(redactLikelyNames(cleanText(candidate.location)));
    candidate.extraInfo = generalizeAddress(redactLikelyNames(cleanText(candidate.extraInfo)));
    candidate.timeReceived = cleanText(candidate.timeReceived);
    if (process.env.ALLOW_PUBLIC_EXTRA_INFO !== 'true')
        candidate.extraInfo = '';
    if (candidate.sensitivity === 'high') {
        candidate.call = 'Sensitive incident';
        candidate.extraInfo = '';
        candidate.location = '';
    }
    return publicPostSchema.parse(candidate);
}
export function generalizeAddress(value) {
    return cleanText(value).replace(streetAddressPattern, match => {
        const street = match.replace(/^\d{1,6}\s+/, '').trim();
        return `1200 block of ${street}`;
    }).replace(/\s*(?:,\s*)?(?:apt(?:artment)?|suite|ste\.?|unit|#)\s*[A-Z0-9-]+\b/gi, '').trim();
}
function cleanText(value) {
    return value.replace(phonePattern, '').replace(emailPattern, '').replace(/\b(?:name|caller|patient|victim|subject|juvenile)\s*[:=-]\s*[^,;.]+/gi, '').replace(/\b(?:Mr|Mrs|Ms|Miss|Dr)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g, '').replace(/[\s,;]+/g, ' ').trim();
}
function redactLikelyNames(value) {
    return value.replace(probableNamePattern, match => /\b(?:street|st\.?|road|rd\.?|avenue|ave\.?|drive|dr\.?|lane|ln\.?|court|ct\.?|boulevard|blvd\.?|highway|hwy\.?|way)$/i.test(match) ? match : '');
}
function sanitizeJurisdiction(value) {
    const match = jurisdictionMarkerPattern.exec(value);
    const place = match?.[1]?.trim() ?? '';
    const trailingText = match?.[2] ?? value;
    return generalizeAddress([place, redactLikelyNames(trailingText)].filter(Boolean).join(' '));
}
