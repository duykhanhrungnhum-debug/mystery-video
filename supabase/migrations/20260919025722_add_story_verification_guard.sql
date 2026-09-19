alter table public.story_episodes
  add column if not exists verification_status text not null default 'pending',
  add column if not exists verification_attempts integer not null default 0,
  add column if not exists repair_attempts integer not null default 0,
  add column if not exists last_verification_error text,
  add column if not exists last_repair_signature text,
  add column if not exists repair_history jsonb not null default '[]'::jsonb,
  add column if not exists verified_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'story_episodes_verification_status_check'
      and conrelid = 'public.story_episodes'::regclass
  ) then
    alter table public.story_episodes
      add constraint story_episodes_verification_status_check
      check (verification_status in ('pending','verifying','repairing','passed','blocked'));
  end if;
end $$;

create or replace function public.enforce_story_publish_gate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.publish_ready then
    if new.status not in ('video_ready','uploaded')
       or new.processing_status is distinct from 'complete'
       or new.visual_status is distinct from 'complete'
       or nullif(btrim(coalesce(new.final_video_storage_path,'')), '') is null
       or new.verification_status is distinct from 'passed'
       or new.verified_at is null then
      raise exception 'story_publish_gate_failed'
        using detail = 'publish_ready requires verified final video, completed visuals, and passed verification';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_story_publish_gate on public.story_episodes;
create trigger trg_enforce_story_publish_gate
before insert or update of publish_ready,status,processing_status,visual_status,final_video_storage_path,verification_status,verified_at
on public.story_episodes
for each row execute function public.enforce_story_publish_gate();
