alter table public.story_episodes
  add column if not exists visual_attempts integer not null default 0,
  add column if not exists visual_error text,
  add column if not exists visual_last_repair_signature text,
  add column if not exists visual_failure_history jsonb not null default '[]'::jsonb,
  add column if not exists visual_claimed_at timestamptz;
