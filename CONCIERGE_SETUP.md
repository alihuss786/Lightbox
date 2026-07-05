# Concierge tier — setup

The **Concierge** tier lets a customer design a lightbox but **not** download an STL.
Instead they get a **“Print for me”** button that uploads the finished `.3mf` to your
private Supabase Storage and files a `print_jobs` row. You (the owner) are **emailed**
and can review every job in an **in-app queue**.

All the app code is already committed. This file is the backend you provision in
**your** Supabase + Vercel (the code can’t create these for you). Until it exists,
paid/normal tiers are unaffected — the concierge path just isn’t reachable.

---

## 1. Supabase — Storage bucket

Dashboard → **Storage** → **New bucket**:
- Name: `print-jobs`
- **Private** (Public = OFF)

Or via SQL:

```sql
insert into storage.buckets (id, name, public)
values ('print-jobs', 'print-jobs', false)
on conflict (id) do nothing;
```

## 2. Supabase — `print_jobs` table

SQL editor → run:

```sql
create table if not exists public.print_jobs (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  user_id     uuid not null references auth.users(id),
  email       text,
  file_path   text not null,
  filename    text,
  summary     jsonb,
  size_bytes  bigint,
  status      text not null default 'new'
);
alter table public.print_jobs enable row level security;
```

## 3. Supabase — RLS policies

Rows are **inserted only by the server** (service key), so users need no insert
policy. Only **you** may read/manage jobs. Replace the email with yours everywhere.

```sql
-- Owner can see every job (in-app queue)
create policy "owner reads jobs" on public.print_jobs
  for select using ( (auth.jwt() ->> 'email') = 'ali.hussain755@outlook.com' );

-- Owner can update status (Mark done)
create policy "owner updates jobs" on public.print_jobs
  for update using ( (auth.jwt() ->> 'email') = 'ali.hussain755@outlook.com' );
```

Storage: let a signed-in user upload into **their own folder**, and let **you** read
every file:

```sql
-- Customer may upload only into a folder named after their own user id
create policy "user uploads own folder" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'print-jobs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Owner may read all files (dashboard downloads)
create policy "owner reads files" on storage.objects
  for select using (
    bucket_id = 'print-jobs'
    and (auth.jwt() ->> 'email') = 'ali.hussain755@outlook.com'
  );
```

> The `/api/print-job` server route uses the **service key**, which bypasses RLS —
> so job records + the emailed signed link work regardless of these policies. The
> policies above are what power the **in-app owner queue** and block everyone else.

> **Which email is this?** The RLS + client `OWNER_EMAIL` must be the email you
> **sign into signaturelightboxes.com with** (your Supabase *Auth* user). This
> whole setup uses `ali.hussain755@outlook.com` for everything. One-time step:
> sign into the app with Outlook (magic link / OTP to that inbox) so the Auth
> user is created — being an Owner on the Supabase *dashboard* is not the same
> thing and does not create an app login.

## 4. Grant a customer the Concierge tier

Your app reads `licenses.tier`. Set it to `concierge` for the customer, and make
sure they have **no** download quota so the normal Export path is also denied
server-side (defence in depth — the UI already hides it):

```sql
update public.licenses
set tier = 'concierge',
    quota_type = 'none',      -- or whatever your schema uses for "no exports"
    exports_remaining = 0
where user_id = (select id from auth.users where email = 'customer@example.com');
```

If your `consume_export()` SQL function grants exports by tier, add an early guard:

```sql
-- inside consume_export(uid), before granting:
-- if the user's tier is 'concierge', always deny:
--   if (select tier from public.licenses where user_id = uid) = 'concierge' then
--     return json_build_object('allowed', false, 'reason', 'concierge_no_export');
--   end if;
```

(You can also mint concierge via your existing `pending_licenses` / redeem-code
flow — just use `tier = 'concierge'`.)

## 5. Vercel — environment variables

Settings → Environment Variables (Production + Preview). You already have the three
`SUPABASE_*` ones; add:

| Var | Value | Needed for |
|-----|-------|-----------|
| `OWNER_EMAIL` | `ali.hussain755@outlook.com` | inbox for job emails (comma-separate for several) |
| `RESEND_API_KEY` | `re_...` | the email notification |
| `FROM_EMAIL` | `orders@signaturelightboxes.com` | sender on your verified Resend domain |
| `PRINT_BUCKET` | `print-jobs` | (optional; this is the default) |

**Also update the owner email in the client:** in `lb.html`, the concierge script
sets `var OWNER_EMAIL="ali.hussain755@outlook.com";` — this controls who sees the in-app
**Print jobs** button. Change it if your owner login differs.

## 6. Email — Resend (for the notification half)

1. Use your existing Resend account (the one with **signaturelightboxes.com** verified).
2. Create an API key (API Keys → Create → name it `lightbox`) → put it in `RESEND_API_KEY` (step 5).
3. Set `FROM_EMAIL` to any address on the verified domain, e.g. `orders@signaturelightboxes.com`
   (no mailbox needed — a verified domain can send from any address on it).

If `RESEND_API_KEY` is unset, jobs still save and appear in the in-app queue — you
just don’t get the email. Swap Resend for SendGrid/Postmark by editing the one
`fetch("https://api.resend.com/emails", …)` block in `api/print-job.js`.

---

## How it works end-to-end

1. Concierge customer designs, taps **🖨 Print for me**.
2. Browser builds the production `.3mf` (identical to a paid export) and uploads it
   **straight to Storage** — bypassing Vercel’s 4.5 MB function-body limit.
3. Browser calls `POST /api/print-job` with the storage path + a small summary.
4. Server verifies the user, inserts the `print_jobs` row (service key), mints a
   14-day signed link, and emails you.
5. You get the email **and** can open **🖨 Print jobs** (bottom-left, owner only) to
   download any job and mark it done.

## Testing checklist

- Sign in as a **concierge** user → the export button reads **“🖨 Print for me”**.
- Tap it → “Sent — we’ll print it”; a row appears in Storage + `print_jobs`; you get
  an email (if Resend is set).
- Sign in as the **owner email** → **🖨 Print jobs** button appears → the job lists
  with a working **Download** button.
- Sign in as a **paid** user → button still reads **“⬇ Export STL”** and downloads
  normally.
