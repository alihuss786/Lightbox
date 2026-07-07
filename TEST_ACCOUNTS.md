# Test accounts — one per tier

Four throwaway accounts so you can test each tier without real emails. They use
**password** sign-in (no magic link needed).

## Credentials

| Tier | Email | Password |
|------|-------|----------|
| Concierge | `concierge@sltest.com` | `Concierge123!` |
| Hobby | `hobby@sltest.com` | `Hobby123!` |
| Studio | `studio@sltest.com` | `Studio123!` |
| Merchant | `merchant@sltest.com` | `Merchant123!` |

## Step 1 — create the 4 users in Supabase (30 sec each)

Supabase → **Authentication → Users → Add user** (do this 4 times):
- enter the **email** and **password** from the table above
- **tick "Auto Confirm User"** (so no verification email is needed)
- Create user

## Step 2 — grant each the right licence

Supabase → **SQL Editor → New query** → paste → Run:

```sql
-- Concierge: design + order prints on site, no STL downloads
insert into public.licenses (user_id, tier, quota_type, quota_limit)
select id, 'concierge', 'total', 0 from auth.users where email = 'concierge@sltest.com'
on conflict (user_id) do update set tier='concierge', quota_type='total', quota_limit=0;

-- Hobby: up to 30 downloads (personal)
insert into public.licenses (user_id, tier, quota_type, quota_limit)
select id, 'hobby', 'total', 30 from auth.users where email = 'hobby@sltest.com'
on conflict (user_id) do update set tier='hobby', quota_type='total', quota_limit=30;

-- Studio: unlimited downloads (personal)
insert into public.licenses (user_id, tier, quota_type, quota_limit)
select id, 'studio', 'unlimited', 0 from auth.users where email = 'studio@sltest.com'
on conflict (user_id) do update set tier='studio', quota_type='unlimited', quota_limit=0;

-- Merchant: unlimited, commercial licence
insert into public.licenses (user_id, tier, quota_type, quota_limit)
select id, 'merchant', 'unlimited', 0 from auth.users where email = 'merchant@sltest.com'
on conflict (user_id) do update set tier='merchant', quota_type='unlimited', quota_limit=0;
```

> This uses only the four columns every `licenses` table has, so it will run
> as-is. (Hobby won't have a 12-month expiry date in the test — not needed to
> verify the tier.) If you ever see a red error mentioning a column name, paste
> it to me and I'll adjust.

## Step 3 — sign in

On the site: **Sign in → type the email → "Have a password? Sign in" → enter the
password**. The account panel will show the tier (Concierge / Hobby / Studio /
Merchant), the licence type (Personal/Commercial), and the export allowance.

- **Concierge** → export button reads **"🖨 Print for me"** (no download)
- **Hobby** → **30** exports, counts down as you export, expires in 12 months
- **Studio / Merchant** → **Unlimited** exports
- **Merchant** → licence row shows **Commercial**
