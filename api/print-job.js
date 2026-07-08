// Vercel serverless function: files a concierge "Print for me" job.
// The browser has already uploaded the .3mf straight to Supabase Storage
// (private "print-jobs" bucket) — that path never passes through here, so the
// 4.5 MB serverless body limit is a non-issue. This endpoint:
//   1) verifies the signed-in user (and reads their trusted email),
//   2) records a print_jobs row with the SECRET key (bypasses RLS),
//   3) mints a long-lived signed download link for the file, and
//   4) emails the owner a notification with that link (best-effort).
//
// Env vars (Vercel → Settings → Environment Variables):
//   SUPABASE_URL          e.g. https://xxxx.supabase.co
//   SUPABASE_ANON_KEY     the sb_publishable_... key (public)
//   SUPABASE_SECRET_KEY   the sb_secret_... key (SECRET — server only)
//   OWNER_EMAIL           where job notifications go (comma-separate for several; default ali.hussain755@outlook.com)
//   RESEND_API_KEY        optional — enables the email notification
//   FROM_EMAIL            optional — verified Resend sender (default onboarding@resend.dev)
//   PRINT_BUCKET          optional — Storage bucket name (default "print-jobs")

import { sendOrderEmails, signedDownloadUrl } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, reason: "method_not_allowed" });
    return;
  }

  const SUPA_URL = process.env.SUPABASE_URL;
  const ANON = process.env.SUPABASE_ANON_KEY;
  const SECRET = process.env.SUPABASE_SECRET_KEY;
  const OWNER_EMAIL = process.env.OWNER_EMAIL || "ali.hussain755@outlook.com,support@signaturelightboxes.com";
  const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
  const FROM_EMAIL = process.env.FROM_EMAIL || "onboarding@resend.dev";
  const BUCKET = process.env.PRINT_BUCKET || "print-jobs";
  const LOGO_URL = process.env.LOGO_URL || "https://signaturelightboxes.com/email-logo.jpg";
  if (!SUPA_URL || !ANON || !SECRET) {
    res.status(500).json({ ok: false, reason: "server_not_configured" });
    return;
  }

  // 1) Verify the caller and read their trusted identity from Supabase Auth.
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) { res.status(401).json({ ok: false, reason: "not_signed_in" }); return; }
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

  // Parse + validate the body.
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const filePath = (body.file_path || "").toString();
  const filename = (body.filename || "lightbox.3mf").toString().slice(0, 200);
  const summary = body.summary || null;
  const sizeBytes = Number(body.size_bytes) || null;
  // The client uploads to <user.id>/<file> — enforce that a caller can only file
  // a job for a file inside their own folder.
  if (!filePath || filePath.indexOf(user.id + "/") !== 0) {
    res.status(400).json({ ok: false, reason: "bad_file_path" });
    return;
  }

  // 2) Record the job row with the SECRET key (bypasses RLS).
  let jobId = null;
  try {
    const ins = await fetch(SUPA_URL + "/rest/v1/print_jobs", {
      method: "POST",
      headers: {
        apikey: SECRET,
        Authorization: "Bearer " + SECRET,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        user_id: user.id,
        email: user.email,
        file_path: filePath,
        filename: filename,
        summary: summary,
        size_bytes: sizeBytes,
        status: "new",
      }),
    });
    const rows = await ins.json().catch(() => null);
    if (!ins.ok) {
      res.status(500).json({ ok: false, reason: "record_failed" });
      return;
    }
    jobId = Array.isArray(rows) && rows[0] ? rows[0].id : null;
  } catch (e) {
    res.status(502).json({ ok: false, reason: "record_unreachable" });
    return;
  }

  // 3) Mint a signed download link (14 days). Best-effort — the owner dashboard
  //    can always regenerate one, so a failure here does not fail the job.
  let downloadUrl = "";
  try {
    const sres = await fetch(
      SUPA_URL + "/storage/v1/object/sign/" + BUCKET + "/" + filePath,
      {
        method: "POST",
        headers: {
          apikey: SECRET,
          Authorization: "Bearer " + SECRET,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expiresIn: 60 * 60 * 24 * 14 }),
      }
    );
    const sdata = await sres.json().catch(() => null);
    if (sres.ok && sdata && sdata.signedURL) downloadUrl = SUPA_URL + "/storage/v1" + sdata.signedURL;
  } catch (e) { /* ignore */ }

  // 4) Emails (best-effort): owner notification + customer confirmation.
  await sendOrderEmails(process.env, { user_email: user.email, filename: filename, summary: summary, downloadUrl: downloadUrl });

  res.status(200).json({ ok: true, job_id: jobId, notified: !!RESEND_API_KEY });
}

function escapeHtml(v) {
  return String(v == null ? "" : v).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}
