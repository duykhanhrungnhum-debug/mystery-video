create table if not exists public.series_translation_profiles (
  series_id bigint primary key references public.source_series(id) on delete cascade,
  profile_version integer not null default 1 check (profile_version > 0),
  profile_key text not null default 'auto',
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
