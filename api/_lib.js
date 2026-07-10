// Shared helpers for the API endpoints. Plain fetch against the Supabase + Stripe
// REST APIs — no npm dependencies, matching the rest of api/. Holds the shared
// auth/rate-limit helpers and the kiosk card-payment confirmation.

// Best-effort in-memory rate limiter (per warm serverless instance). Not a hard
// guarantee across instances, but it stops naive hammering of the public GET
// endpoints. For production-grade limiting, back this with Upstash/Redis.
const _rlBuckets = new Map();
export function rateLimit(key, max = 30, windowMs = 60000) {
  const now = Date.now();
  let e = _rlBuckets.get(key);
  if (!e || now > e.reset) { e = { count: 0, reset: now + windowMs }; _rlBuckets.set(key, e); }
  e.count++;
  if (_rlBuckets.size > 5000) { for (const [k, v] of _rlBuckets) { if (now > v.reset) _rlBuckets.delete(k); } }
  return e.count <= max
    ? { ok: true, remaining: max - e.count }
    : { ok: false, retryAfter: Math.max(1, Math.ceil((e.reset - now) / 1000)) };
}

// Pull the caller's IP from Vercel's forwarding headers.
export function clientIp(req) {
  const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.headers["x-real-ip"] || "unknown";
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

// Finalise a KIOSK card payment: re-fetch the Stripe session, and only if it is
// genuinely paid flip the kiosk_orders row to paid/card. Keyed by the
// kiosk_order_id we stashed in the session metadata; returns early (not_kiosk)
// for non-kiosk sessions. Idempotent — safe to run from both the webhook and the
// success redirect.
export async function confirmKioskPaid(env, sessionId, stripeAccount) {
  const STRIPE = env.STRIPE_SECRET_KEY || "";
  if (!STRIPE) return { ok: false, reason: "no_stripe" };
  // For a Connect direct charge the session lives on the merchant's connected
  // account, so we must re-fetch it with the Stripe-Account header.
  const headers = { Authorization: "Bearer " + STRIPE };
  if (stripeAccount) headers["Stripe-Account"] = stripeAccount;
  let session;
  try {
    const r = await fetch("https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(sessionId), { headers });
    session = await r.json().catch(() => null);
    if (!r.ok || !session) return { ok: false, reason: "stripe_error" };
  } catch (e) { return { ok: false, reason: "stripe_unreachable" }; }
  if (session.payment_status !== "paid") return { ok: false, reason: "unpaid" };
  const orderId = session.metadata && session.metadata.kiosk_order_id;
  if (!orderId) return { ok: false, reason: "not_kiosk" };

  const SB = { apikey: env.SUPABASE_SECRET_KEY, Authorization: "Bearer " + env.SUPABASE_SECRET_KEY, "Content-Type": "application/json" };
  let row;
  try {
    const r = await fetch(env.SUPABASE_URL + "/rest/v1/kiosk_orders?id=eq." + encodeURIComponent(orderId) + "&select=id,status", { headers: SB });
    const rows = await r.json().catch(() => null);
    row = Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (e) { return { ok: false, reason: "db_unreachable" }; }
  if (!row) return { ok: false, reason: "order_not_found" };
  if (row.status === "paid" || row.status === "done") return { ok: true, already: true, order_id: orderId };

  try {
    await fetch(env.SUPABASE_URL + "/rest/v1/kiosk_orders?id=eq." + encodeURIComponent(orderId), {
      method: "PATCH", headers: SB, body: JSON.stringify({ status: "paid", payment_method: "card" }),
    });
  } catch (e) { return { ok: false, reason: "update_failed" }; }
  return { ok: true, order_id: orderId };
}
