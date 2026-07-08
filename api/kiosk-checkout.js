// Vercel serverless function: take a card payment for a KIOSK order via Stripe.
//
// Used only when the merchant has set "Card payments = Stripe" in Store settings
// (i.e. they do NOT have their own card machine). The kiosk redirects the
// customer to a Stripe Checkout page priced from the order's saved price_pence,
// and on return the order is flipped to paid/card.
//
//   POST { order_id }            -> { ok, url }        (create + redirect)
//   GET  ?confirm=<session_id>   -> { ok, order_id }   (finalise on return)
//
// If STRIPE_SECRET_KEY is unset the endpoint returns { configured:false } so the
// client can tell the merchant to either configure Stripe or switch to their own
// machine — nothing breaks pre-setup.

import { verifyUser, confirmKioskPaid, rateLimit, clientIp } from "./_lib.js";

export default async function handler(req, res) {
  const env = process.env;
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    res.status(500).json({ ok: false, reason: "server_not_configured" }); return;
  }
  const STRIPE = env.STRIPE_SECRET_KEY || "";
  const SB = { apikey: env.SUPABASE_SECRET_KEY, Authorization: "Bearer " + env.SUPABASE_SECRET_KEY, "Content-Type": "application/json" };

  // look up the connected account (if any) that a kiosk order was charged on,
  // so a direct-charge session can be re-fetched on the right account.
  async function acctForOrder(orderId) {
    if (!orderId) return null;
    try {
      const r = await fetch(env.SUPABASE_URL + "/rest/v1/kiosk_orders?id=eq." + encodeURIComponent(orderId) + "&select=merchant_id", { headers: SB });
      const rows = await r.json().catch(() => null);
      const o = Array.isArray(rows) && rows[0] ? rows[0] : null;
      if (!o || !o.merchant_id) return null;
      const mr = await fetch(env.SUPABASE_URL + "/rest/v1/merchants?user_id=eq." + o.merchant_id + "&select=stripe_account_id", { headers: SB });
      const mrows = await mr.json().catch(() => null);
      const m = Array.isArray(mrows) && mrows[0] ? mrows[0] : null;
      return (m && m.stripe_account_id) || null;
    } catch (e) { return null; }
  }

  // ---- finalise on return from Stripe ----
  if (req.method === "GET") {
    const sid = (req.query && req.query.confirm) || "";
    if (!sid) { res.status(400).json({ ok: false, reason: "no_session" }); return; }
    if (!STRIPE) { res.status(200).json({ ok: false, configured: false }); return; }
    const acct = await acctForOrder((req.query && req.query.order) || "");
    const out = await confirmKioskPaid(env, String(sid), acct);
    res.status(200).json(out); return;
  }

  if (req.method !== "POST") { res.status(405).json({ ok: false, reason: "method_not_allowed" }); return; }
  if (!rateLimit("kck:" + clientIp(req), 30, 60000)) { res.status(429).json({ ok: false, reason: "rate_limited" }); return; }
  if (!STRIPE) { res.status(200).json({ ok: false, configured: false }); return; }

  const user = await verifyUser(env, req.headers.authorization);
  if (!user) { res.status(401).json({ ok: false, reason: "not_signed_in" }); return; }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const orderId = (body.order_id || "").toString();
  if (!orderId) { res.status(400).json({ ok: false, reason: "no_order" }); return; }

  // load the order (service role) and make sure it belongs to the signed-in merchant
  let order;
  try {
    const r = await fetch(env.SUPABASE_URL + "/rest/v1/kiosk_orders?id=eq." + encodeURIComponent(orderId) + "&select=id,merchant_id,price_pence,ticket_code,status", { headers: SB });
    const rows = await r.json().catch(() => null);
    order = Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (e) { res.status(502).json({ ok: false, reason: "db_unreachable" }); return; }
  if (!order) { res.status(404).json({ ok: false, reason: "order_not_found" }); return; }
  if (order.merchant_id !== user.id) { res.status(403).json({ ok: false, reason: "not_your_order" }); return; }
  if (order.status === "paid" || order.status === "done") { res.status(200).json({ ok: true, already: true }); return; }
  const amount = Number(order.price_pence) || 0;
  if (!(amount > 0)) { res.status(400).json({ ok: false, reason: "no_price" }); return; }

  // merchant currency + store name for the Stripe line item, and their connected
  // account (if they've onboarded via Stripe Connect — payments then go direct).
  let cur = "gbp", storeName = "Signature Lightboxes", acct = null;
  try {
    const r = await fetch(env.SUPABASE_URL + "/rest/v1/merchants?user_id=eq." + user.id + "&select=store_name,price_rules,stripe_account_id", { headers: SB });
    const rows = await r.json().catch(() => null);
    const m = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (m) {
      if (m.store_name) storeName = m.store_name;
      const c = m.price_rules && m.price_rules.currency;
      cur = c === "$" ? "usd" : (c === "€" ? "eur" : "gbp");
      acct = m.stripe_account_id || null;
    }
  } catch (e) { /* defaults are fine */ }

  const base = (env.SITE_URL || "https://signaturelightboxes.com").replace(/\/$/, "");
  const form = new URLSearchParams();
  form.set("mode", "payment");
  // include the order id so the return handler can re-fetch the session on the
  // right connected account (direct charges live on the merchant's account).
  form.set("success_url", base + "/?kioskpaid=" + encodeURIComponent(order.ticket_code || order.id) + "&ko=" + encodeURIComponent(order.id) + "&session_id={CHECKOUT_SESSION_ID}");
  form.set("cancel_url", base + "/?kioskpaid=cancel");
  form.set("client_reference_id", order.id);
  form.set("metadata[kiosk_order_id]", order.id);
  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price_data][currency]", cur);
  form.set("line_items[0][price_data][unit_amount]", String(amount));
  form.set("line_items[0][price_data][product_data][name]", storeName + " — Lightbox" + (order.ticket_code ? (" (" + order.ticket_code + ")") : ""));

  // When the merchant has connected their own Stripe, charge directly on their
  // account (Stripe-Account header) so the money settles to them, not the platform.
  const sHeaders = { Authorization: "Bearer " + STRIPE, "Content-Type": "application/x-www-form-urlencoded" };
  if (acct) sHeaders["Stripe-Account"] = acct;

  try {
    const sres = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: sHeaders,
      body: form.toString(),
    });
    const session = await sres.json().catch(() => null);
    if (!sres.ok || !session || !session.url) {
      res.status(502).json({ ok: false, reason: "stripe_error", detail: (session && session.error && session.error.message) || "" });
      return;
    }
    res.status(200).json({ ok: true, url: session.url });
  } catch (e) {
    res.status(502).json({ ok: false, reason: "stripe_unreachable" });
  }
}
