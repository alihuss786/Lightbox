// Vercel serverless function: start a Stripe Checkout for a concierge order.
// The browser has already uploaded the .3mf to Storage. This endpoint verifies
// the user, records an `awaiting_payment` job row, and opens a Stripe Checkout
// Session priced SERVER-SIDE by size (the client price is never trusted). The
// order is only confirmed + emailed after payment (see confirm-order.js).
//
// Env: SUPABASE_*, plus STRIPE_SECRET_KEY (sk_...) and optional SITE_URL.
// If STRIPE_SECRET_KEY is unset the endpoint returns {configured:false} and the
// client falls back to the free submit path — so nothing breaks pre-setup.

import { verifyUser, SIZE_PRICES, SHIP_PENCE } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ ok: false, reason: "method_not_allowed" }); return; }

  const env = process.env;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SECRET_KEY) {
    res.status(500).json({ ok: false, reason: "server_not_configured" }); return;
  }
  const STRIPE = env.STRIPE_SECRET_KEY || "";
  if (!STRIPE) { res.status(200).json({ ok: false, configured: false }); return; } // client free-fallback

  const user = await verifyUser(env, req.headers.authorization);
  if (!user) { res.status(401).json({ ok: false, reason: "not_signed_in" }); return; }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const filePath = (body.file_path || "").toString();
  const filename = (body.filename || "lightbox.3mf").toString().slice(0, 200);
  const summary = body.summary || {};
  const sizeBytes = Number(body.size_bytes) || null;
  if (!filePath || filePath.indexOf(user.id + "/") !== 0) { res.status(400).json({ ok: false, reason: "bad_file_path" }); return; }

  const sizeKey = summary && summary.size && summary.size.key;
  const amount = SIZE_PRICES[sizeKey];
  if (!amount) { res.status(400).json({ ok: false, reason: "bad_size" }); return; }
  const sizeLabel = (summary.size && summary.size.label) || "Custom";
  const sizeCm = (summary.size && summary.size.cm) || "";

  const SB = { apikey: env.SUPABASE_SECRET_KEY, Authorization: "Bearer " + env.SUPABASE_SECRET_KEY, "Content-Type": "application/json" };

  // 1) record the pending (unpaid) order
  let jobId = null;
  try {
    const ins = await fetch(env.SUPABASE_URL + "/rest/v1/print_jobs", {
      method: "POST",
      headers: Object.assign({ Prefer: "return=representation" }, SB),
      body: JSON.stringify({
        user_id: user.id, email: user.email, file_path: filePath, filename: filename,
        summary: summary, size_bytes: sizeBytes, status: "awaiting_payment", payment_amount: amount + SHIP_PENCE,
      }),
    });
    const rows = await ins.json().catch(() => null);
    if (!ins.ok) { res.status(500).json({ ok: false, reason: "record_failed" }); return; }
    jobId = Array.isArray(rows) && rows[0] ? rows[0].id : null;
  } catch (e) { res.status(502).json({ ok: false, reason: "record_unreachable" }); return; }

  // 2) create the Stripe Checkout Session (REST, form-encoded — no SDK needed)
  const base = (env.SITE_URL || "https://signaturelightboxes.com").replace(/\/$/, "");
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", base + "/?order=success&session_id={CHECKOUT_SESSION_ID}");
  form.set("cancel_url", base + "/?order=cancel");
  if (user.email) form.set("customer_email", user.email);
  form.set("client_reference_id", jobId || "");
  form.set("metadata[job_id]", jobId || "");
  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price_data][currency]", "gbp");
  form.set("line_items[0][price_data][unit_amount]", String(amount));
  form.set("line_items[0][price_data][product_data][name]", "Signature Lightbox — " + sizeLabel + (sizeCm ? " (" + sizeCm + "cm)" : ""));
  // flat UK delivery as its own line so the customer sees it itemised at checkout
  form.set("line_items[1][quantity]", "1");
  form.set("line_items[1][price_data][currency]", "gbp");
  form.set("line_items[1][price_data][unit_amount]", String(SHIP_PENCE));
  form.set("line_items[1][price_data][product_data][name]", "UK delivery");

  try {
    const sres = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: "Bearer " + STRIPE, "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const session = await sres.json().catch(() => null);
    if (!sres.ok || !session || !session.url) {
      res.status(502).json({ ok: false, reason: "stripe_error", detail: (session && session.error && session.error.message) || "" });
      return;
    }
    // link the session back to the row (for confirm-order lookups / reconciliation)
    try {
      await fetch(env.SUPABASE_URL + "/rest/v1/print_jobs?id=eq." + jobId, {
        method: "PATCH", headers: SB, body: JSON.stringify({ payment_session_id: session.id }),
      });
    } catch (e) { /* non-fatal */ }
    res.status(200).json({ ok: true, url: session.url, job_id: jobId });
  } catch (e) {
    res.status(502).json({ ok: false, reason: "stripe_unreachable" });
  }
}
