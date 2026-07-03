// Vercel serverless function: redeems a backer code and grants the matching tier.
// Verifies the signed-in user, then calls the locked-down redeem_code() function
// with the SECRET key (which maps the code's tier to the right quota + expiry and
// creates the user's licence atomically, marking the code used).

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, reason: "method_not_allowed" });
    return;
  }

  const SUPA_URL = process.env.SUPABASE_URL;
  const ANON = process.env.SUPABASE_ANON_KEY;
  const SECRET = process.env.SUPABASE_SECRET_KEY;
  if (!SUPA_URL || !ANON || !SECRET) {
    res.status(500).json({ ok: false, reason: "server_not_configured" });
    return;
  }

  // Parse the code from the body.
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const code = ((body && body.code) || "").toString().trim().toUpperCase();
  if (!code) {
    res.status(400).json({ ok: false, reason: "no_code" });
    return;
  }

  // Verify the caller.
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    res.status(401).json({ ok: false, reason: "not_signed_in" });
    return;
  }
  let user;
  try {
    const ures = await fetch(SUPA_URL + "/auth/v1/user", {
      headers: { apikey: ANON, Authorization: "Bearer " + token },
    });
    if (!ures.ok) { res.status(401).json({ ok: false, reason: "invalid_session" }); return; }
    user = await ures.json();
  } catch (e) {
    res.status(502).json({ ok: false, reason: "auth_unreachable" });
    return;
  }
  if (!user || !user.id) { res.status(401).json({ ok: false, reason: "invalid_session" }); return; }

  // Redeem (SECRET key bypasses RLS; the SQL function does the atomic work).
  try {
    const rres = await fetch(SUPA_URL + "/rest/v1/rpc/redeem_code", {
      method: "POST",
      headers: {
        apikey: SECRET,
        Authorization: "Bearer " + SECRET,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uid: user.id, code_input: code }),
    });
    const data = await rres.json().catch(() => null);
    if (!rres.ok) { res.status(500).json({ ok: false, reason: "redeem_error" }); return; }
    res.status(200).json(data || { ok: false, reason: "no_result" });
  } catch (e) {
    res.status(502).json({ ok: false, reason: "redeem_unreachable" });
  }
}
