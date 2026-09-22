create table if not exists public.series_translation_profiles (
  series_id bigint primary key references public.source_series(id) on delete cascade,
  profile_version integer not null default 1 check (profile_version > 0),
  profile_key text not null default 'universal',
  genre text not null default 'auto',
  register text not null default 'natural cinematic Vietnamese',
  pronoun_policy text not null default 'infer_from_relationship_and_context',
  glossary jsonb not null default '{}'::jsonb,
  style_rules jsonb not null default '[]'::jsonb,
  character_memory jsonb not null default '{}'::jsonb,
  detected_from text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.series_translation_profiles enable row level security;

create table if not exists public.longform_segment_cache (
  id bigserial primary key,
  series_id bigint not null references public.source_series(id) on delete cascade,
  source_video_id text not null,
  segment_key text not null,
  segment_index integer not null check (segment_index > 0),
  start_ms integer not null check (start_ms >= 0),
  end_ms integer not null check (end_ms >= start_ms),
  source_text text not null,
  source_context_hash text not null,
  profile_version integer not null default 1,
  model_key text not null,
  translation text not null,
  qa_state text not null default 'passed' check (qa_state in ('passed','reviewed','repaired')),
  translation_hash text,
  tts_voice text,
  tts_hash text,
  tts_storage_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(series_id, source_video_id, segment_key, profile_version, model_key)
);
alter table public.longform_segment_cache enable row level security;

create index if not exists longform_segment_cache_lookup_idx
  on public.longform_segment_cache(series_id, source_video_id, profile_version, model_key, segment_key);
create index if not exists longform_segment_cache_updated_idx
  on public.longform_segment_cache(updated_at desc);
