// Vercel serverless function: Stripe webhook (hardening/backup for confirm-order).
// Stripe guarantees delivery of checkout.session.completed even if the customer
// closes the tab before the success redirect fires — so this guarantees paid
// orders are always finalised + emailed, exactly once.
//
// Security: instead of verifying the webhook signature (which needs the raw
// request body — awkward on Vercel's auto-parsed Node functions), we re-fetch
// the session straight from Stripe with our secret key and only act if it's
// genuinely paid. A forged call therefore can't confirm an unpaid order, and
// confirmPaidOrder is idempotent so duplicate deliveries are harmless.
//
// Setup: Stripe → Developers → Webhooks → Add endpoint
//   URL: https://signaturelightboxes.com/api/stripe-webhook
//   Event: checkout.session.completed

import { confirmPaidOrder, confirmKioskPaid } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ received: false }); return; }
  const env = process.env;
  if (!env.STRIPE_SECRET_KEY || !env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    res.status(200).json({ received: true, skipped: "not_configured" }); return;
  }

  let event = req.body;
  if (typeof event === "string") { try { event = JSON.parse(event); } catch (e) { event = null; } }
  const session = event && event.data && event.data.object;
  const type = event && event.type;

  // Only act on a completed checkout; ACK everything else so Stripe stops retrying.
  if (type === "checkout.session.completed" && session && session.id) {
    try { await confirmPaidOrder(env, session.id); } catch (e) { /* idempotent; ACK anyway */ }
    try { await confirmKioskPaid(env, session.id); } catch (e) { /* idempotent; ACK anyway */ }
  }
  res.status(200).json({ received: true });
}
