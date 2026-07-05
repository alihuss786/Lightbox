// Vercel serverless function: confirm a paid concierge order after Stripe
// Checkout. Called by the client on the success redirect with the session id.
// The heavy lifting (re-verify with Stripe, mark paid, email) lives in
// confirmPaidOrder, shared with the webhook. Idempotent.

import { confirmPaidOrder } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ ok: false, reason: "method_not_allowed" }); return; }
  const env = process.env;
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY || !env.STRIPE_SECRET_KEY) {
    res.status(500).json({ ok: false, reason: "server_not_configured" }); return;
  }
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const sessionId = (body && body.session_id || "").toString();
  if (!sessionId) { res.status(400).json({ ok: false, reason: "no_session" }); return; }

  const r = await confirmPaidOrder(env, sessionId);
  res.status(r.ok ? 200 : 200).json(r);
}
