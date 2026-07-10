// Vercel serverless function: Stripe webhook (hardening/backup for the kiosk
// card-payment success redirect). Stripe guarantees delivery of
// checkout.session.completed even if the customer closes the tab before the
// success redirect fires — so this guarantees paid kiosk orders are always
// finalised, exactly once.
//
// Security: instead of verifying the webhook signature (which needs the raw
// request body — awkward on Vercel's auto-parsed Node functions), we re-fetch
// the session straight from Stripe with our secret key and only act if it's
// genuinely paid. A forged call therefore can't confirm an unpaid order, and
// confirmKioskPaid is idempotent so duplicate deliveries are harmless.
//
// Setup: Stripe → Developers → Webhooks → Add endpoint
//   URL: https://signaturelightboxes.com/api/stripe-webhook
//   Event: checkout.session.completed

import { confirmKioskPaid } from "./_lib.js";

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
    // event.account is set for Connect direct charges (kiosk merchant's own Stripe)
    try { await confirmKioskPaid(env, session.id, event.account); } catch (e) { /* idempotent; ACK anyway */ }
  }
  res.status(200).json({ received: true });
}
