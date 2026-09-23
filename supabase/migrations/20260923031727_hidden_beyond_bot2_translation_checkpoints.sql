create table if not exists public.hidden_beyond_bot2_checkpoints (
  source_video_id text primary key,
  worker_revision text not null,
  phase text not null,
  cursor integer not null default 0 check (cursor >= 0),
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.hidden_beyond_bot2_checkpoints enable row level security;

revoke all on table public.hidden_beyond_bot2_checkpoints from anon, authenticated;
grant select, insert, update, delete on table public.hidden_beyond_bot2_checkpoints to service_role;

create index if not exists hidden_beyond_bot2_checkpoints_updated_at_idx
  on public.hidden_beyond_bot2_checkpoints(updated_at desc);
