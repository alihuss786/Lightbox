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
  status      text not null default 'new',   -- awaiting_payment | new | done
  payment_amount     int,                         -- pence, once Stripe is on
  payment_session_id text
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

-- Owner can update status (Mark done / Move to pending)
create policy "owner updates jobs" on public.print_jobs
  for update using ( (auth.jwt() ->> 'email') = 'ali.hussain755@outlook.com' );

-- Owner can delete completed orders (dashboard Delete)
create policy "owner deletes jobs" on public.print_jobs
  for delete using ( (auth.jwt() ->> 'email') = 'ali.hussain755@outlook.com' );
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

-- Owner may delete files (dashboard Delete)
create policy "owner deletes files" on storage.objects
  for delete using (
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
-- Upsert so it works whether or not the customer already has a licence row.
-- quota_type must be one of: total | monthly | unlimited. Use total + limit 0
-- so a concierge user has zero downloads (the UI also hides Export).
insert into public.licenses (user_id, tier, quota_type, quota_limit)
values (
  (select id from auth.users where email = 'customer@example.com'),
  'concierge', 'total', 0
)
on conflict (user_id) do update
  set tier = 'concierge', quota_type = 'total', quota_limit = 0;
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

## 7. Owner sign-in password + dashboard

When you sign into the site with the **owner email** (`ali.hussain755@outlook.com`),
the app asks for a **password** — everyone else still gets the passwordless email
link — and then drops you on a full-screen **Order requests** dashboard instead of
the designer. (From the dashboard, **Open designer** returns to the tool; the
floating **Orders** button reopens the dashboard.)

Set the owner password in Supabase, one-time:

1. Supabase → **Authentication → Users**.
2. If your user detail panel has a password/**Reset password** field, set one there and skip to step 4.
3. Otherwise: delete the existing owner user (**⋯ → Delete user** — safe, the queue
   is keyed by email, not user id), then **Add user → Create new user**:
   - Email: `ali.hussain755@outlook.com`
   - Password: a strong password
   - **Auto Confirm User: ON**
4. Sign into signaturelightboxes.com with the owner email → it asks for the
   password → you land on the dashboard.

> Security: the password is validated by Supabase Auth, and the order data is
> protected by the RLS policies in step 3 (only the owner email can read jobs).

## 8. Payment — Stripe (optional until you’re ready)

“Print for me” charges the customer per size via **Stripe Checkout**. Prices are set
**server-side** (`SIZE_PRICES` in `api/_lib.js`): Small £20, Medium £35, Large £45.
**If `STRIPE_SECRET_KEY` is not set, orders submit free** — fine for pre-launch testing.

1. Create a Stripe account → **Developers → API keys** → copy the **Secret key**
   (`sk_test_...` while testing, `sk_live_...` for real charges).
2. Vercel → Environment Variables, add:
   - `STRIPE_SECRET_KEY` = `sk_...`
   - `SITE_URL` = `https://signaturelightboxes.com` (used for the return links)
3. Add the payment columns (if your table predates them):

```sql
alter table public.print_jobs add column if not exists payment_amount int;
alter table public.print_jobs add column if not exists payment_session_id text;
```

4. **Redeploy.**

No Stripe Products/Prices to create — each order builds its price inline. To change
prices, edit `SIZE_PRICES` in `api/_lib.js` (pence) **and** `CONCIERGE_SIZES` in
`lb.html` (keep them in sync).

Flow: customer pays on Stripe’s hosted page → returns to the site → the app calls
`/api/confirm-order`, which **re-checks with Stripe that the session is paid** before
marking the order and emailing. Abandoned/unpaid checkouts stay `awaiting_payment`
and never appear in your dashboard.

Test with a `sk_test_` key and card **4242 4242 4242 4242**, any future expiry/CVC.

### Webhook (recommended — guarantees paid orders finalise)

The success redirect confirms most orders, but if a customer pays then closes the
tab before returning, the redirect never fires. The webhook covers that: Stripe
delivers `checkout.session.completed` server-to-server, and `/api/stripe-webhook`
finalises the order (idempotent — no double-processing with the redirect).

Stripe → **Developers → Webhooks → Add endpoint**:
- Endpoint URL: `https://signaturelightboxes.com/api/stripe-webhook`
- Event to send: **`checkout.session.completed`**

No `STRIPE_WEBHOOK_SECRET` needed — the handler re-verifies each session directly
with Stripe (using your secret key) before acting, so a forged call can't confirm
an unpaid order.

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
