// Vercel serverless function: issue an Apple/Google Wallet pass for a kiosk order,
// via WalletWallet (https://www.walletwallet.dev) — one API call returns a signed
// Apple .pkpass + a "Save to Google Wallet" link. Dormant until WALLETWALLET_API_KEY
// is set (the wallet buttons then appear on the customer's order-status page).
//
// The pass barcode is the order URL (…/?order=SL-XXXX) so scanning the pass at the
// stall pulls the order up in the kiosk scanner — same code as every other ticket QR.
//
// Env vars (Vercel → Settings → Environment Variables):
//   WALLETWALLET_API_KEY   ww_live_…  (SECRET — server only)
//   SUPABASE_URL, SUPABASE_SECRET_KEY   (optional — to brand the pass with store + status)
//   SITE_URL               e.g. https://signaturelightboxes.com  (optional; inferred otherwise)

const STATUS_LABEL = { new: "Order received", paid: "Being made", done: "Ready to collect" };

export default async function handler(req, res) {
  const KEY = process.env.WALLETWALLET_API_KEY;
  const raw = (req.query && (req.query.code || req.query.order)) || "";
  const code = String(Array.isArray(raw) ? raw[0] : raw).trim().toUpperCase().slice(0, 24);
  const platform = String((req.query && req.query.platform) || "").toLowerCase();

  if (!KEY) { res.status(200).json({ ok: false, reason: "not_configured" }); return; }
  if (!/^[A-Z0-9-]{3,24}$/.test(code)) { res.status(400).json({ ok: false, reason: "bad_code" }); return; }

  // Optional: brand the pass with the store name + live status (best-effort).
  let store = "", status = "new";
  const SUPA_URL = process.env.SUPABASE_URL, SECRET = process.env.SUPABASE_SECRET_KEY;
  if (SUPA_URL && SECRET) {
    try {
      const H = { apikey: SECRET, Authorization: "Bearer " + SECRET };
      const or = await fetch(SUPA_URL + "/rest/v1/kiosk_orders?ticket_code=eq." +
        encodeURIComponent(code) + "&select=status,merchant_id&limit=1", { headers: H });
      const o = (await or.json().catch(() => []))[0];
      if (o) {
        status = o.status || "new";
        if (o.merchant_id) {
          const mr = await fetch(SUPA_URL + "/rest/v1/merchants?user_id=eq." +
            encodeURIComponent(o.merchant_id) + "&select=store_name&limit=1", { headers: H });
          const m = (await mr.json().catch(() => []))[0];
          if (m) store = m.store_name || "";
        }
      }
    } catch (e) { /* branding optional */ }
  }

  const brand = store || "Signature Lightboxes";
  const SITE = (process.env.SITE_URL || ("https://" + (req.headers.host || "signaturelightboxes.com"))).replace(/\/$/, "");
  const orderUrl = SITE + "/?order=" + encodeURIComponent(code);

  const body = {
    // NB: serialNumber & authenticationToken are server-owned by WalletWallet — do not send them.
    barcodeValue: orderUrl,
    barcodeFormat: "QR",
    barcodeAltText: code,
    logoText: brand,
    description: "Order " + code,
    organizationName: brand,
    backgroundColor: "rgb(20,22,27)",
    foregroundColor: "rgb(224,192,141)",
    labelColor: "rgb(139,147,161)",
    primaryFields: [{ label: "ORDER", value: code }],
    secondaryFields: [
      { label: "Store", value: brand },
      { label: "Status", value: STATUS_LABEL[status] || "Order received" },
    ],
  };

  let data;
  try {
    const r = await fetch("https://api.walletwallet.dev/api/passes", {
      method: "POST",
      headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    data = await r.json().catch(() => null);
    if (!r.ok) {
      res.status(502).json({ ok: false, reason: "pass_failed", detail: (data && (data.error || data.message)) || ("http_" + r.status) });
      return;
    }
  } catch (e) { res.status(502).json({ ok: false, reason: "unreachable" }); return; }

  // Tolerate small differences in field naming across API versions.
  const googleUrl = data && (data.googleSaveUrl || data.googlePayUrl || data.saveUrl || (data.google && (data.google.saveUrl || data.google.url)) || "");
  const appleB64 = data && (data.applePass || data.pkpass || data.applePassBase64 || (data.apple && data.apple.pkpass) || "");
  // shareUrl = WalletWallet's hosted page that auto-shows the right button per device.
  const shareUrl = data && (data.shareUrl || data.share_url || "");

  // Apple path: stream the signed .pkpass so iOS offers "Add to Apple Wallet".
  if (platform === "apple") {
    if (!appleB64) { res.status(502).json({ ok: false, reason: "no_apple_pass" }); return; }
    const buf = Buffer.from(appleB64, "base64");
    res.setHeader("Content-Type", "application/vnd.apple.pkpass");
    res.setHeader("Content-Disposition", 'attachment; filename="' + code + '.pkpass"');
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(buf);
    return;
  }

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: true,
    shareUrl: shareUrl || "",
    googleSaveUrl: googleUrl || "",
    appleUrl: appleB64 ? (SITE + "/api/wallet-pass?platform=apple&code=" + encodeURIComponent(code)) : "",
    // surfaced only for your own debugging via the raw endpoint URL
    has: { google: !!googleUrl, apple: !!appleB64, share: !!shareUrl },
  });
}
