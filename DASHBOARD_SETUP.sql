-- ============================================================================
-- Signature Lightboxes — Owner dashboard tables
-- Run this once in your Supabase project:  Dashboard → SQL Editor → New query →
-- paste all of this → Run.  Safe to run again (idempotent).
--
-- What it creates:
--   • templates   — designs you publish for every visitor to load (public read,
--                   only you can add/edit/delete).
--   • site_config — a single row holding which studio tabs are on / "coming
--                   soon" / hidden (public read, only you can change).
--
-- Owner is matched by email. If your owner email ever changes, update the three
-- occurrences of the address below.
-- ============================================================================

-- ---------- TEMPLATES -------------------------------------------------------
create table if not exists public.templates (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  data       jsonb not null,
  sort       int  not null default 0,
  created_at timestamptz not null default now()
);

alter table public.templates enable row level security;

drop policy if exists "templates public read"  on public.templates;
drop policy if exists "templates owner write"   on public.templates;

create policy "templates public read"
  on public.templates for select
  using (true);

create policy "templates owner write"
  on public.templates for all
  using      ( (auth.jwt() ->> 'email') = 'ali.hussain755@outlook.com' )
  with check ( (auth.jwt() ->> 'email') = 'ali.hussain755@outlook.com' );

-- ---------- SITE CONFIG (single row, id = 1) --------------------------------
create table if not exists public.site_config (
  id         int primary key default 1,
  config     jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint site_config_singleton check (id = 1)
);

alter table public.site_config enable row level security;

drop policy if exists "config public read" on public.site_config;
drop policy if exists "config owner write"  on public.site_config;

create policy "config public read"
  on public.site_config for select
  using (true);

create policy "config owner write"
  on public.site_config for all
  using      ( (auth.jwt() ->> 'email') = 'ali.hussain755@outlook.com' )
  with check ( (auth.jwt() ->> 'email') = 'ali.hussain755@outlook.com' );

-- seed the single config row so the app always has something to read
insert into public.site_config (id, config)
values (1, '{}'::jsonb)
on conflict (id) do nothing;

-- ---------- NAME GRAPHICS (owner-uploaded, traced in the browser) -----------
create table if not exists public.graphics (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  emoji      text default '🎨',
  data       jsonb not null,          -- { ink:[[...]], sil:[[...]] }
  sort       int  not null default 0,
  created_at timestamptz not null default now()
);

alter table public.graphics enable row level security;

drop policy if exists "graphics public read" on public.graphics;
drop policy if exists "graphics owner write"  on public.graphics;

create policy "graphics public read"
  on public.graphics for select
  using (true);

create policy "graphics owner write"
  on public.graphics for all
  using      ( (auth.jwt() ->> 'email') = 'ali.hussain755@outlook.com' )
  with check ( (auth.jwt() ->> 'email') = 'ali.hussain755@outlook.com' );
