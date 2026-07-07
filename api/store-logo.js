// Vercel serverless function: serve a merchant's uploaded store logo as an image.
// The merchant uploads it in the kiosk Store settings (stored on merchants.logo_url
// as a data URL); the wallet pass points its logoURL here so the pass shows the
// store's own logo — no external hosting needed.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEY

const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml" };

export default async function handler(req, res) {
  const SUPA_URL = process.env.SUPABASE_URL, SECRET = process.env.SUPABASE_SECRET_KEY;
  if (!SUPA_URL || !SECRET) { res.status(500).end(); return; }

  const rawCode = (req.query && (req.query.code || req.query.order)) || "";
  const code = String(Array.isArray(rawCode) ? rawCode[0] : rawCode).trim().toUpperCase().slice(0, 24);
  const rawM = (req.query && req.query.m) || "";
  const mid = String(Array.isArray(rawM) ? rawM[0] : rawM).trim();

  const H = { apikey: SECRET, Authorization: "Bearer " + SECRET };
  try {
    let merchantId = mid;
    if (!merchantId) {
      if (!/^[A-Z0-9-]{3,24}$/.test(code)) { res.status(400).end(); return; }
      const or = await fetch(SUPA_URL + "/rest/v1/kiosk_orders?ticket_code=eq." +
        encodeURIComponent(code) + "&select=merchant_id&limit=1", { headers: H });
      const o = (await or.json().catch(() => []))[0];
      if (!o || !o.merchant_id) { res.status(404).end(); return; }
      merchantId = o.merchant_id;
    }
    const mr = await fetch(SUPA_URL + "/rest/v1/merchants?user_id=eq." +
      encodeURIComponent(merchantId) + "&select=logo_url&limit=1", { headers: H });
    const m = (await mr.json().catch(() => []))[0];
    const url = m && m.logo_url;
    if (!url) { res.status(404).end(); return; }

    // http(s) logo -> redirect; data: URL -> decode + serve the bytes
    if (/^https?:\/\//i.test(url)) { res.redirect(302, url); return; }
    const mData = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(url);
    if (!mData) { res.status(404).end(); return; }
    const mime = mData[1] || "image/png";
    const isB64 = !!mData[2];
    const body = isB64 ? Buffer.from(mData[3], "base64") : Buffer.from(decodeURIComponent(mData[3]), "utf8");
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.status(200).send(body);
  } catch (e) { res.status(502).end(); }
}
