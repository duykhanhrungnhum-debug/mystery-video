alter table public.story_episodes
  add column if not exists processing_last_repair_signature text,
  add column if not exists processing_failure_history jsonb not null default '[]'::jsonb;
