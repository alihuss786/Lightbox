// Vercel serverless function: confirm a paid concierge order after Stripe
// Checkout. Called by the client on the success redirect with the session id.
// It re-fetches the session FROM Stripe (so a forged call can't confirm an
// unpaid order), and only then flips the job row to `new` and sends the emails.
// Idempotent: re-calling for an already-confirmed order is a no-op.
//
// Env: SUPABASE_*, STRIPE_SECRET_KEY, plus the email vars used by _lib.

import { sendOrderEmails, signedDownloadUrl } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ ok: false, reason: "method_not_allowed" }); return; }
  const env = process.env;
  const STRIPE = env.STRIPE_SECRET_KEY || "";
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY || !STRIPE) {
    res.status(500).json({ ok: false, reason: "server_not_configured" }); return;
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const sessionId = (body && body.session_id || "").toString();
  if (!sessionId) { res.status(400).json({ ok: false, reason: "no_session" }); return; }

  // 1) Verify the session really is paid, straight from Stripe.
  let session;
  try {
    const sres = await fetch("https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(sessionId), {
      headers: { Authorization: "Bearer " + STRIPE },
    });
    session = await sres.json().catch(() => null);
    if (!sres.ok || !session) { res.status(502).json({ ok: false, reason: "stripe_error" }); return; }
  } catch (e) { res.status(502).json({ ok: false, reason: "stripe_unreachable" }); return; }
  if (session.payment_status !== "paid") { res.status(200).json({ ok: false, reason: "unpaid" }); return; }

  const jobId = session.metadata && session.metadata.job_id;
  if (!jobId) { res.status(400).json({ ok: false, reason: "no_job_ref" }); return; }

  const SB = { apikey: env.SUPABASE_SECRET_KEY, Authorization: "Bearer " + env.SUPABASE_SECRET_KEY, "Content-Type": "application/json" };

  // 2) Load the row; if already confirmed, we're done (idempotent).
  let job;
  try {
    const r = await fetch(env.SUPABASE_URL + "/rest/v1/print_jobs?id=eq." + jobId + "&select=*", { headers: SB });
    const rows = await r.json().catch(() => null);
    job = Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (e) { res.status(502).json({ ok: false, reason: "db_unreachable" }); return; }
  if (!job) { res.status(404).json({ ok: false, reason: "job_not_found" }); return; }
  if (job.status !== "awaiting_payment") { res.status(200).json({ ok: true, already: true }); return; }

  // 3) Mark paid → new, then notify.
  try {
    await fetch(env.SUPABASE_URL + "/rest/v1/print_jobs?id=eq." + jobId, {
      method: "PATCH", headers: SB, body: JSON.stringify({ status: "new" }),
    });
  } catch (e) { res.status(502).json({ ok: false, reason: "update_failed" }); return; }

  const downloadUrl = await signedDownloadUrl(env, job.file_path);
  await sendOrderEmails(env, {
    user_email: job.email, filename: job.filename, summary: job.summary,
    downloadUrl: downloadUrl, amount: session.amount_total,
  });

  res.status(200).json({ ok: true, job_id: jobId });
}
