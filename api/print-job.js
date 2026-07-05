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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, reason: "method_not_allowed" });
    return;
  }

  const SUPA_URL = process.env.SUPABASE_URL;
  const ANON = process.env.SUPABASE_ANON_KEY;
  const SECRET = process.env.SUPABASE_SECRET_KEY;
  const OWNER_EMAIL = process.env.OWNER_EMAIL || "ali.hussain755@outlook.com";
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

  // 4) Email the owner (best-effort; only if a key is configured).
  if (RESEND_API_KEY) {
    try {
      const s = (summary && typeof summary === "object") ? summary : {};
      const rowsHtml = [
        ["Customer", user.email],
        ["Letter", s.letter || "—"],
        ["Plates", s.plates != null ? String(s.plates) : "—"],
        ["Printer", s.printer || "—"],
        ["Size", s.size ? (s.size.label + " (" + s.size.cm + " cm tall)") : "—"],
        ["Price", (s.size && s.size.price != null) ? ("£" + s.size.price) : "—"],
        ["File", filename],
      ].map(([k, v]) =>
        `<tr><td style="padding:10px 0;color:#8b8f98;font-size:13px;border-bottom:1px solid #23252b">${k}</td>` +
        `<td style="padding:10px 0;color:#f2f3f5;font-size:13px;font-weight:600;text-align:right;border-bottom:1px solid #23252b">${escapeHtml(v)}</td></tr>`
      ).join("");
      const sh = (s.shipping && typeof s.shipping === "object") ? s.shipping : null;
      const shipHtml = sh
        ? `<div style="margin-top:16px;padding:14px 16px;background:#0f1116;border:1px solid #23252b;border-radius:12px">`
          + `<div style="color:#d8b877;font-size:11px;font-weight:700;letter-spacing:.06em;margin-bottom:6px">SHIP TO</div>`
          + `<div style="color:#f2f3f5;font-size:14px;font-weight:600">${escapeHtml(sh.name || "")}</div>`
          + `<div style="color:#c7cbd2;font-size:13px;line-height:1.55">${[sh.line1, sh.line2, sh.city, sh.postcode, sh.country].filter(Boolean).map(escapeHtml).join("<br>")}</div>`
          + `<div style="color:#8b8f98;font-size:12px;margin-top:8px">${[sh.email, sh.phone].filter(Boolean).map(escapeHtml).join(" &middot; ")}</div>`
          + (sh.notes ? `<div style="color:#8b8f98;font-size:12px;margin-top:6px;font-style:italic">&ldquo;${escapeHtml(sh.notes)}&rdquo;</div>` : "")
          + `</div>`
        : "";
      const link = downloadUrl
        ? `<tr><td align="center" style="padding:26px 0 8px"><a href="${downloadUrl}" style="display:inline-block;padding:13px 32px;background:#d8b877;color:#1a1206;font-weight:700;font-size:14px;text-decoration:none;border-radius:10px">⬇ Download .3mf</a></td></tr>`
          + `<tr><td align="center" style="color:#7c808a;font-size:11px;padding-bottom:2px">Link valid 14 days · also in your in-app Print jobs queue</td></tr>`
        : `<tr><td align="center" style="color:#9aa0aa;font-size:13px;padding:22px 0">Open the in-app <b style="color:#f2f3f5">Print jobs</b> queue to download the file.</td></tr>`;
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + RESEND_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Lightbox Studio <" + FROM_EMAIL + ">",
          to: OWNER_EMAIL.split(",").map((e) => e.trim()).filter(Boolean),
          subject: "🖨 New Lightbox print job — " + (user.email || "customer"),
          html:
            `<div style="margin:0;padding:0;background:#0b0b0d">` +
            `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0b0d;padding:30px 12px"><tr><td align="center">` +
            `<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">` +
            `<tr><td align="center" style="padding:4px 0 22px"><img src="${LOGO_URL}" width="240" alt="Signature Lightboxes" style="display:block;width:240px;max-width:72%;height:auto;border-radius:12px"></td></tr>` +
            `<tr><td style="background:#141419;border:1px solid #23252b;border-radius:16px;padding:26px 28px">` +
            `<div style="color:#f2f3f5;font:700 19px system-ui,-apple-system,Segoe UI,sans-serif">New &ldquo;Print for me&rdquo; order</div>` +
            `<div style="color:#8b8f98;font:400 13px system-ui,sans-serif;margin:4px 0 18px">A concierge customer sent a design to print.</div>` +
            `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:system-ui,sans-serif">${rowsHtml}</table>` +
            shipHtml +
            `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">` + link + `</table>` +
            `</td></tr>` +
            `<tr><td align="center" style="color:#5c606a;font:400 11px system-ui,sans-serif;padding:18px 0 4px">Signature Lightboxes · concierge print queue</td></tr>` +
            `</table></td></tr></table></div>`,
        }),
      });
    } catch (e) { /* email is best-effort */ }
  }

  res.status(200).json({ ok: true, job_id: jobId, notified: !!RESEND_API_KEY });
}

function escapeHtml(v) {
  return String(v == null ? "" : v).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}
