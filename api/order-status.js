// Vercel serverless function: public order-status lookup for the ticket QR code.
// A customer scans their ticket QR -> opens signaturelightboxes.com/?order=SL-XXXX
// -> the page calls this endpoint to show the order's status. Uses the SECRET key
// (bypasses RLS) but returns ONLY non-sensitive fields: status, store name/logo,
// created date, ticket. Never the design, customer name, or contact details.
//
// Env vars (Vercel → Settings → Environment Variables):
//   SUPABASE_URL         e.g. https://xxxx.supabase.co
//   SUPABASE_SECRET_KEY  the sb_secret_... key  (SECRET — server only)

import { rateLimit, clientIp } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, reason: "method_not_allowed" });
    return;
  }
  const rl = rateLimit("os:" + clientIp(req), 60, 60000);
  if (!rl.ok) { res.setHeader("Retry-After", rl.retryAfter); res.status(429).json({ ok: false, reason: "rate_limited" }); return; }

  const SUPA_URL = process.env.SUPABASE_URL;
  const SECRET = process.env.SUPABASE_SECRET_KEY;
  if (!SUPA_URL || !SECRET) {
    res.status(500).json({ ok: false, reason: "server_not_configured" });
    return;
  }

  // Normalise the ticket code from the query (?code= or ?order=).
  const raw = (req.query && (req.query.code || req.query.order)) || "";
  const code = String(Array.isArray(raw) ? raw[0] : raw).trim().toUpperCase().slice(0, 24);
  if (!code || !/^[A-Z0-9-]{3,24}$/.test(code)) {
    res.status(400).json({ ok: false, reason: "bad_code" });
    return;
  }

  const H = { apikey: SECRET, Authorization: "Bearer " + SECRET };

  try {
    // 1) find the order by its ticket code (only the safe columns)
    const q = SUPA_URL + "/rest/v1/kiosk_orders?ticket_code=eq." +
      encodeURIComponent(code) + "&select=status,created_at,merchant_id,ticket_code,fulfilment&limit=1";
    const or = await fetch(q, { headers: H });
    if (!or.ok) { res.status(502).json({ ok: false, reason: "lookup_failed" }); return; }
    const rows = await or.json().catch(() => []);
    const o = Array.isArray(rows) && rows[0];
    if (!o) { res.status(200).json({ ok: false, reason: "not_found" }); return; }

    // 2) look up the store's public branding (name + logo)
    let store = "", logo = "";
    if (o.merchant_id) {
      try {
        const mr = await fetch(SUPA_URL + "/rest/v1/merchants?user_id=eq." +
          encodeURIComponent(o.merchant_id) + "&select=store_name,logo_url&limit=1", { headers: H });
        if (mr.ok) {
          const m = (await mr.json().catch(() => []))[0];
          if (m) { store = m.store_name || ""; logo = m.logo_url || ""; }
        }
      } catch (e) { /* branding is optional */ }
    }

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      ok: true,
      ticket: o.ticket_code || code,
      status: o.status || "new",
      created_at: o.created_at || null,
      fulfilment: (o.fulfilment && o.fulfilment.mode)
        ? { mode: o.fulfilment.mode, collectDate: o.fulfilment.collectDate || null }
        : null,
      store,
      logo,
    });
  } catch (e) {
    res.status(502).json({ ok: false, reason: "unreachable" });
  }
}
