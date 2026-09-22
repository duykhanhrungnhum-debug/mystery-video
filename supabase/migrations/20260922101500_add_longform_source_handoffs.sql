create table if not exists public.longform_source_handoffs (
  id uuid primary key default gen_random_uuid(),
  source_video_id text not null,
  token_hash text not null,
  state text not null default 'created' check (state in ('created','running','completed','failed')),
  message text,
  storage_path text not null,
  metadata jsonb,
  created_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  completed_at timestamptz,
  failed_at timestamptz,
  expires_at timestamptz not null
);
alter table public.longform_source_handoffs enable row level security;
create index if not exists longform_source_handoffs_created_idx
  on public.longform_source_handoffs(created_at desc);
