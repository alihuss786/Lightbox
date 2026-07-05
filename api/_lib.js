// Shared helpers for the concierge order endpoints (print-job, create-checkout,
// confirm-order). Plain fetch against the Supabase + Stripe + Resend REST APIs —
// no npm dependencies, matching the rest of api/.

export function escapeHtml(v) {
  return String(v == null ? "" : v).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

// Verify a Supabase access token and return the user ({id,email}) or null.
export async function verifyUser(env, authHeader) {
  const token = (authHeader || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  try {
    const r = await fetch(env.SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: "Bearer " + token },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id && u.email ? u : null;
  } catch (e) { return null; }
}

// Mint a signed download URL for a stored file (owner/studio only).
export async function signedDownloadUrl(env, filePath, seconds) {
  const BUCKET = env.PRINT_BUCKET || "print-jobs";
  try {
    const r = await fetch(env.SUPABASE_URL + "/storage/v1/object/sign/" + BUCKET + "/" + filePath, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SECRET_KEY,
        Authorization: "Bearer " + env.SUPABASE_SECRET_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: seconds || 60 * 60 * 24 * 14 }),
    });
    const d = await r.json().catch(() => null);
    if (r.ok && d && d.signedURL) return env.SUPABASE_URL + "/storage/v1" + d.signedURL;
  } catch (e) { /* ignore */ }
  return "";
}

// Build + send the two branded order emails (owner notification with download,
// customer confirmation without). Best-effort; no-op without RESEND_API_KEY.
export async function sendOrderEmails(env, o) {
  if (!env.RESEND_API_KEY) return;
  const FROM = env.FROM_EMAIL || "onboarding@resend.dev";
  const OWNER = (env.OWNER_EMAIL || "ali.hussain755@outlook.com").split(",").map((e) => e.trim()).filter(Boolean);
  const LOGO = env.LOGO_URL || "https://signaturelightboxes.com/email-logo.jpg";
  const s = (o.summary && typeof o.summary === "object") ? o.summary : {};
  const sh = (s.shipping && typeof s.shipping === "object") ? s.shipping : null;
  const paidLine = (o.amount != null) ? ("£" + (o.amount / 100).toFixed(2) + " paid") : ((s.size && s.size.price != null) ? ("£" + s.size.price) : "—");

  const row = (k, v) =>
    `<tr><td style="padding:10px 0;color:#8b8f98;font-size:13px;border-bottom:1px solid #23252b">${k}</td>` +
    `<td style="padding:10px 0;color:#f2f3f5;font-size:13px;font-weight:600;text-align:right;border-bottom:1px solid #23252b">${escapeHtml(v)}</td></tr>`;
  const core =
    row("Letter", s.letter || "—") +
    row("Size", s.size ? (s.size.label + " (" + s.size.cm + " cm tall)") : "—") +
    row("Paid", paidLine) +
    row("Printer", s.printer || "—");
  const ownerRows = row("Customer", o.user_email) + core;
  const shipHtml = sh
    ? `<div style="margin-top:16px;padding:14px 16px;background:#0f1116;border:1px solid #23252b;border-radius:12px">`
      + `<div style="color:#d8b877;font-size:11px;font-weight:700;letter-spacing:.06em;margin-bottom:6px">SHIP TO</div>`
      + `<div style="color:#f2f3f5;font-size:14px;font-weight:600">${escapeHtml(sh.name || "")}</div>`
      + `<div style="color:#c7cbd2;font-size:13px;line-height:1.55">${[sh.line1, sh.line2, sh.city, sh.postcode, sh.country].filter(Boolean).map(escapeHtml).join("<br>")}</div>`
      + `<div style="color:#8b8f98;font-size:12px;margin-top:8px">${[sh.email, sh.phone].filter(Boolean).map(escapeHtml).join(" &middot; ")}</div>`
      + (sh.notes ? `<div style="color:#8b8f98;font-size:12px;margin-top:6px;font-style:italic">&ldquo;${escapeHtml(sh.notes)}&rdquo;</div>` : "")
      + `</div>`
    : "";
  const ownerBtn = o.downloadUrl
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:26px 0 8px"><a href="${o.downloadUrl}" style="display:inline-block;padding:13px 32px;background:#d8b877;color:#1a1206;font-weight:700;font-size:14px;text-decoration:none;border-radius:10px">⬇ Download .3mf</a></td></tr><tr><td align="center" style="color:#7c808a;font-size:11px;padding-bottom:2px">Link valid 14 days · also in your in-app dashboard</td></tr></table>`
    : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="color:#9aa0aa;font-size:13px;padding:22px 0">Open your in-app <b style="color:#f2f3f5">dashboard</b> to download the file.</td></tr></table>`;
  const shell = (title, intro, bodyRows, extra) =>
    `<div style="margin:0;padding:0;background:#0b0b0d">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0b0d;padding:30px 12px"><tr><td align="center">` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">` +
    `<tr><td align="center" style="padding:4px 0 22px"><img src="${LOGO}" width="240" alt="Signature Lightboxes" style="display:block;width:240px;max-width:72%;height:auto;border-radius:12px"></td></tr>` +
    `<tr><td style="background:#141419;border:1px solid #23252b;border-radius:16px;padding:26px 28px">` +
    `<div style="color:#f2f3f5;font:700 19px system-ui,-apple-system,Segoe UI,sans-serif">${title}</div>` +
    `<div style="color:#8b8f98;font:400 13px system-ui,sans-serif;margin:4px 0 18px">${intro}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:system-ui,sans-serif">${bodyRows}</table>` +
    shipHtml + (extra || "") +
    `</td></tr>` +
    `<tr><td align="center" style="color:#5c606a;font:400 11px system-ui,sans-serif;padding:18px 0 4px">Signature Lightboxes</td></tr>` +
    `</table></td></tr></table></div>`;

  const send = (to, subject, html) => fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "Signature Lightboxes <" + FROM + ">", to, subject, html }),
  });

  try {
    await send(OWNER, "🖨 New Lightbox order — " + (o.user_email || "customer"),
      shell("New order received", "A concierge customer placed an order.", ownerRows, ownerBtn));
    const custExtra = `<div style="margin-top:18px;color:#c7cbd2;font-size:13px;line-height:1.6">We&rsquo;re on it! Your lightbox will be printed and posted to the address above. We&rsquo;ll be in touch if we need anything, and again when it ships. Thank you for your order.</div>`;
    const customerEmail = ((sh && sh.email) || o.user_email || "").trim();
    if (customerEmail.indexOf("@") > 0)
      await send([customerEmail], "Your Signature Lightboxes order is confirmed ✨",
        shell("Thank you &mdash; your order is confirmed!", "We&rsquo;ve received your design and payment, and we&rsquo;re getting it ready to print.", core, custExtra));
  } catch (e) { /* best-effort */ }
}

// Server-authoritative pricing (pence). Keep in sync with CONCIERGE_SIZES in lb.html.
export const SIZE_PRICES = { small: 2000, medium: 3500, large: 4500 };
