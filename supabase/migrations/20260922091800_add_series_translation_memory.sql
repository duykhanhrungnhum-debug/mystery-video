create table if not exists public.series_translation_memory (
  id bigserial primary key,
  series_id bigint not null references public.source_series(id) on delete cascade,
  source_hash text not null,
  source_text text not null,
  translation text not null,
  profile_version integer not null default 1,
  model_key text not null,
  qa_state text not null default 'passed' check (qa_state in ('passed','reviewed','repaired')),
  use_count integer not null default 0 check (use_count >= 0),
  first_source_video_id text,
  last_source_video_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(series_id, source_hash, profile_version, model_key)
);
alter table public.series_translation_memory enable row level security;
create index if not exists series_translation_memory_lookup_idx
  on public.series_translation_memory(series_id, profile_version, model_key, source_hash);
