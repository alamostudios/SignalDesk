UPDATE incidents
SET public_data = jsonb_set(
      jsonb_set(public_data, '{jurisdiction}', to_jsonb('Review required'::text), true),
      '{call}', to_jsonb('Radio call details pending'::text), true
    ) || '{"sensitivity":"low"}'::jsonb,
    updated_at = now()
WHERE event_type <> 'manual'
  AND status = 'draft'
  AND coalesce(transcript, '') = ''
  AND public_data->>'call' = 'Sensitive incident'
  AND internal_data->>'processingNote' = 'Configure transcription and reasoning providers, or complete this draft manually.';
