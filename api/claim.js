// Vercel serverless function: auto-grants a backer their tier by email.
// After a backer signs in, the app calls this if they have no licence yet.
// It verifies the user, then calls claim_license() with the SECRET key —
// which looks up the pending_licenses table by the user's verified email
// and, if a row exists, creates their licence and marks it claimed.

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

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) { res.status(401).json({ ok: false, reason: "not_signed_in" }); return; }

  // Verify the user AND read their email from the trusted token response.
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
  if (!user || !user.id || !user.email) {
    res.status(401).json({ ok: false, reason: "invalid_session" });
    return;
  }

  // Claim any pending licence matching this email.
  try {
    const rres = await fetch(SUPA_URL + "/rest/v1/rpc/claim_license", {
      method: "POST",
      headers: {
        apikey: SECRET,
        Authorization: "Bearer " + SECRET,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uid: user.id, email_input: user.email }),
    });
    const data = await rres.json().catch(() => null);
    if (!rres.ok) { res.status(500).json({ ok: false, reason: "claim_error" }); return; }
    res.status(200).json(data || { ok: false, reason: "no_result" });
  } catch (e) {
    res.status(502).json({ ok: false, reason: "claim_unreachable" });
  }
}
