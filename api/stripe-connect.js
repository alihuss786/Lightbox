// Vercel serverless function: Stripe Connect onboarding for kiosk MERCHANTS.
//
// Lets a merchant connect their OWN Stripe account (Express) so kiosk card
// payments settle straight to them — the platform is only the facilitator.
//
//   POST { action:"onboard" } -> { ok, url }   create/reuse the Express account
//                                               + return an onboarding link
//   POST { action:"status"  } -> { ok, connected, charges_enabled, ... }
//
// The connected account id is stored on the merchant's row (stripe_account_id)
// and later used by /api/kiosk-checkout to create a direct charge on it.
//
// Setup: in the Stripe Dashboard enable Connect (Platform profile) and, on your
// webhook endpoint, tick "Listen to events on Connected accounts".

import { verifyUser, rateLimit, clientIp } from "./_lib.js";

export default async function handler(req, res) {
  const env = process.env;
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    res.status(500).json({ ok: false, reason: "server_not_configured" }); return;
  }
  const STRIPE = env.STRIPE_SECRET_KEY || "";
  if (req.method !== "POST") { res.status(405).json({ ok: false, reason: "method_not_allowed" }); return; }
  if (!rateLimit("scon:" + clientIp(req), 20, 60000)) { res.status(429).json({ ok: false, reason: "rate_limited" }); return; }
  if (!STRIPE) { res.status(200).json({ ok: false, configured: false }); return; }

  const user = await verifyUser(env, req.headers.authorization);
  if (!user) { res.status(401).json({ ok: false, reason: "not_signed_in" }); return; }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const action = (body.action || "status").toString();

  const SB = { apikey: env.SUPABASE_SECRET_KEY, Authorization: "Bearer " + env.SUPABASE_SECRET_KEY, "Content-Type": "application/json" };
  const SFORM = { Authorization: "Bearer " + STRIPE, "Content-Type": "application/x-www-form-urlencoded" };

  async function getMerch() {
    try {
      const r = await fetch(env.SUPABASE_URL + "/rest/v1/merchants?user_id=eq." + user.id + "&select=stripe_account_id", { headers: SB });
      const rows = await r.json().catch(() => null);
      return Array.isArray(rows) && rows[0] ? rows[0] : null;
    } catch (e) { return null; }
  }
  async function setAcct(acct) {
    try {
      // upsert so it works even before the merchant has saved their profile once
      await fetch(env.SUPABASE_URL + "/rest/v1/merchants", {
        method: "POST",
        headers: Object.assign({ Prefer: "resolution=merge-duplicates" }, SB),
        body: JSON.stringify({ user_id: user.id, stripe_account_id: acct }),
      });
    } catch (e) { /* non-fatal */ }
  }

  const m = await getMerch();
  let acct = (m && m.stripe_account_id) || null;

  if (action === "status") {
    if (!acct) { res.status(200).json({ ok: true, connected: false }); return; }
    try {
      const r = await fetch("https://api.stripe.com/v1/accounts/" + encodeURIComponent(acct), { headers: { Authorization: "Bearer " + STRIPE } });
      const a = await r.json().catch(() => null);
      if (!r.ok || !a) { res.status(200).json({ ok: true, connected: true, account_id: acct, charges_enabled: false }); return; }
      res.status(200).json({
        ok: true, connected: true, account_id: acct,
        charges_enabled: !!a.charges_enabled, details_submitted: !!a.details_submitted, payouts_enabled: !!a.payouts_enabled,
      });
    } catch (e) { res.status(200).json({ ok: true, connected: true, account_id: acct, charges_enabled: false }); }
    return;
  }

  if (action === "onboard") {
    // 1) create the Express account if we don't have one yet
    if (!acct) {
      const form = new URLSearchParams();
      form.set("type", "express");
      if (user.email) form.set("email", user.email);
      form.set("capabilities[card_payments][requested]", "true");
      form.set("capabilities[transfers][requested]", "true");
      try {
        const r = await fetch("https://api.stripe.com/v1/accounts", { method: "POST", headers: SFORM, body: form.toString() });
        const a = await r.json().catch(() => null);
        if (!r.ok || !a || !a.id) { res.status(502).json({ ok: false, reason: "account_create_failed", detail: (a && a.error && a.error.message) || "" }); return; }
        acct = a.id;
        await setAcct(acct);
      } catch (e) { res.status(502).json({ ok: false, reason: "stripe_unreachable" }); return; }
    }
    // 2) create an onboarding link back to the app
    const base = (env.SITE_URL || "https://signaturelightboxes.com").replace(/\/$/, "");
    const lf = new URLSearchParams();
    lf.set("account", acct);
    lf.set("refresh_url", base + "/?stripe=refresh");
    lf.set("return_url", base + "/?stripe=connected");
    lf.set("type", "account_onboarding");
    try {
      const r = await fetch("https://api.stripe.com/v1/account_links", { method: "POST", headers: SFORM, body: lf.toString() });
      const link = await r.json().catch(() => null);
      if (!r.ok || !link || !link.url) { res.status(502).json({ ok: false, reason: "link_failed", detail: (link && link.error && link.error.message) || "" }); return; }
      res.status(200).json({ ok: true, url: link.url });
    } catch (e) { res.status(502).json({ ok: false, reason: "stripe_unreachable" }); }
    return;
  }

  res.status(400).json({ ok: false, reason: "bad_action" });
}
