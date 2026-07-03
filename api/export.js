// Vercel serverless function: authorises one STL export.
// Verifies the signed-in user, then atomically checks + decrements their quota
// via the locked-down consume_export() function using the SECRET key.
// Env vars (set in Vercel → Settings → Environment Variables):
//   SUPABASE_URL         e.g. https://xxxx.supabase.co
//   SUPABASE_ANON_KEY    the sb_publishable_... key (safe/public)
//   SUPABASE_SECRET_KEY  the sb_secret_... key  (SECRET — server only)

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ allowed: false, reason: "method_not_allowed" });
    return;
  }

  const SUPA_URL = process.env.SUPABASE_URL;
  const ANON = process.env.SUPABASE_ANON_KEY;
  const SECRET = process.env.SUPABASE_SECRET_KEY;
  if (!SUPA_URL || !ANON || !SECRET) {
    res.status(500).json({ allowed: false, reason: "server_not_configured" });
    return;
  }

  // 1) Who is calling? Verify the user's access token with Supabase Auth.
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    res.status(401).json({ allowed: false, reason: "not_signed_in" });
    return;
  }

  let user;
  try {
    const ures = await fetch(SUPA_URL + "/auth/v1/user", {
      headers: { apikey: ANON, Authorization: "Bearer " + token },
    });
    if (!ures.ok) {
      res.status(401).json({ allowed: false, reason: "invalid_session" });
      return;
    }
    user = await ures.json();
  } catch (e) {
    res.status(502).json({ allowed: false, reason: "auth_unreachable" });
    return;
  }
  if (!user || !user.id) {
    res.status(401).json({ allowed: false, reason: "invalid_session" });
    return;
  }

  // 2) Atomically check + decrement the quota (SECRET key bypasses RLS).
  try {
    const cres = await fetch(SUPA_URL + "/rest/v1/rpc/consume_export", {
      method: "POST",
      headers: {
        apikey: SECRET,
        Authorization: "Bearer " + SECRET,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uid: user.id }),
    });
    const data = await cres.json().catch(() => null);
    if (!cres.ok) {
      res.status(500).json({ allowed: false, reason: "quota_error" });
      return;
    }
    // data = { allowed, remaining, reason }
    res.status(200).json(data || { allowed: false, reason: "no_result" });
  } catch (e) {
    res.status(502).json({ allowed: false, reason: "quota_unreachable" });
  }
}
