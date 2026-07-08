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

-- ---------- KIOSK ORDERS (customer designs captured at a merchant's stall) ----
create table if not exists public.kiosk_orders (
  id          uuid primary key default gen_random_uuid(),
  merchant_id uuid not null default auth.uid(),
  customer    text,
  contact     text,
  note        text,
  design      jsonb not null,
  status      text  not null default 'new',   -- new -> paid -> done
  ticket_code text,                            -- short claim code shown to the customer (+QR)
  price_pence int,                             -- reserved for live pricing
  created_at  timestamptz not null default now()
);

-- if kiosk_orders already exists from an earlier run, add the newer columns
alter table public.kiosk_orders add column if not exists ticket_code text;
alter table public.kiosk_orders add column if not exists price_pence int;
alter table public.kiosk_orders add column if not exists fulfilment jsonb;  -- {mode, address:{}, collectDate}
alter table public.kiosk_orders add column if not exists payment_method text; -- 'cash' | 'card' (recorded when merchant marks paid)

alter table public.kiosk_orders enable row level security;

drop policy if exists "kiosk own"        on public.kiosk_orders;
drop policy if exists "kiosk owner read" on public.kiosk_orders;

-- a merchant has full access to their OWN captured orders
create policy "kiosk own"
  on public.kiosk_orders for all
  using ( merchant_id = auth.uid() )
  with check ( merchant_id = auth.uid() );

-- the owner can read every merchant's orders
create policy "kiosk owner read"
  on public.kiosk_orders for select
  using ( (auth.jwt() ->> 'email') = 'ali.hussain755@outlook.com' );

-- ---------- MERCHANTS (per-store kiosk profile: branding, filaments, printer) ----
-- One row per merchant account. Loaded at boot to co-brand the kiosk, limit the
-- colour picker to the filaments actually loaded, and match the plate/fit-check
-- to the store's printer.
create table if not exists public.merchants (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null unique default auth.uid(),
  store_name text,
  logo_url   text,
  filaments  jsonb not null default '[]'::jsonb,   -- ["#E2663B", ...] loaded colours
  max_x_mm   int  not null default 256,            -- printer build size (fit-check)
  max_y_mm   int  not null default 256,
  max_z_mm   int  not null default 256,
  price_rules jsonb not null default '{}'::jsonb,  -- reserved for live pricing
  idle_secs  int  not null default 90,             -- attract-loop / reset timeout
  screensaver_url text,                            -- idle DVD-bounce logo (image/gif/mp4)
  updated_at timestamptz not null default now()
);

-- if the merchants table already exists from an earlier run, add the newer columns
alter table public.merchants add column if not exists screensaver_url text;
alter table public.merchants add column if not exists fulfilment jsonb not null default '{}'::jsonb;

alter table public.merchants enable row level security;

drop policy if exists "merchant own"        on public.merchants;
drop policy if exists "merchant owner read"  on public.merchants;

-- a merchant has full access to their OWN profile row
create policy "merchant own"
  on public.merchants for all
  using ( user_id = auth.uid() )
  with check ( user_id = auth.uid() );

-- the owner can read every merchant's profile
create policy "merchant owner read"
  on public.merchants for select
  using ( (auth.jwt() ->> 'email') = 'ali.hussain755@outlook.com' );

-- Live filament stock: let the kiosk receive merchant-profile changes in real time
-- (so marking a colour out of stock on your phone updates the kiosk instantly).
-- Wrapped so re-running never errors ("already member of publication").
do $$ begin
  alter publication supabase_realtime add table public.merchants;
exception when duplicate_object then null; end $$;
