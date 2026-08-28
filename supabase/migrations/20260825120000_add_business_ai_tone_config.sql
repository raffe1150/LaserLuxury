alter table public.businesses
  add column if not exists ai_tone_config jsonb not null default jsonb_build_object(
    'tonePreset', 'professional',
    'responseLength', 'balanced',
    'emojiUsage', 'none',
    'formality', 'balanced',
    'customToneInstructions', ''
  );

comment on column public.businesses.ai_tone_config is
  'Structured style-only AI communication preferences. Operational and factual instructions retain precedence.';

alter table public.businesses
  drop constraint if exists businesses_ai_tone_config_shape;

alter table public.businesses
  add constraint businesses_ai_tone_config_shape check (
    jsonb_typeof(ai_tone_config) = 'object'
    and ai_tone_config ?& array['tonePreset', 'responseLength', 'emojiUsage', 'formality', 'customToneInstructions']
    and jsonb_typeof(ai_tone_config->'tonePreset') = 'string'
    and ai_tone_config->>'tonePreset' in ('professional', 'friendly', 'warm', 'casual', 'concise', 'custom')
    and jsonb_typeof(ai_tone_config->'responseLength') = 'string'
    and ai_tone_config->>'responseLength' in ('short', 'balanced', 'detailed')
    and jsonb_typeof(ai_tone_config->'emojiUsage') = 'string'
    and ai_tone_config->>'emojiUsage' in ('none', 'light', 'expressive')
    and jsonb_typeof(ai_tone_config->'formality') = 'string'
    and ai_tone_config->>'formality' in ('formal', 'balanced', 'casual')
    and jsonb_typeof(ai_tone_config->'customToneInstructions') = 'string'
    and length(ai_tone_config->>'customToneInstructions') <= 500
  );
