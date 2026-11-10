// supabase/functions/xend-pay/index.ts
//
// The ONLY code that can turn a payment into an order or a wallet credit.
//
//   POST {action:"preorder", name, phone, email, method, product_id}  -> {reference, url}
//   POST {action:"deposit",  k, pin, amount}                           -> {reference, url, fee, net}
//   POST {action:"verify",   reference}                                -> {status, ...}
//   POST (Paystack webhook, x-paystack-signature header)               -> confirms charge.success
//
// Every path ends in settle(): it asks Paystack (with the SECRET key) whether the
// transaction really succeeded and for how much, then calls confirm_payment(), which
// compares that amount with the amount the database stored when checkout started.
// Nothing the browser sends can create an order.
//
// Secrets (supabase secrets set ...):
//   PAYSTACK_SECRET_KEY   sk_live_... (or sk_test_...)
//   SITE_URL              exact public URL of the app, e.g. https://shop.example.com/
// Deploy WITHOUT jwt verification (Paystack cannot send one):
//   supabase functions deploy xend-pay --no-verify-jwt
// Paystack dashboard > Settings > API Keys & Webhooks > Webhook URL:
//   https://<project-ref>.supabase.co/functions/v1/xend-pay

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PSK = Deno.env.get("PAYSTACK_SECRET_KEY") ?? "";
const SITE = Deno.env.get("SITE_URL") ?? "";

const db = createClient(SB_URL, SRK, { auth: { persistSession: false } });

const siteOrigin = (() => { try { return new URL(SITE).origin; } catch { return "*"; } })();
const cors = {
  "Access-Control-Allow-Origin": siteOrigin,
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

const clean = (m: string) => String(m || "Something went wrong.").replace(/^.*?ERROR:\s*/i, "").slice(0, 300);

async function hmac512(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(PSK), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function paystack(path: string, init?: RequestInit) {
  const r = await fetch("https://api.paystack.co" + path, {
    ...init,
    headers: { Authorization: `Bearer ${PSK}`, "Content-Type": "application/json" },
  });
  return await r.json();
}

// Ask Paystack what really happened, then let the database decide.
async function settle(reference: string) {
  const v = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`);
  const d = v?.data;
  if (!v?.status || !d) return { status: "unknown" };
  if (d.status === "success") {
    const { data, error } = await db.rpc("confirm_payment", {
      p_ref: reference,
      p_amount: Number(d.amount),
      p_currency: String(d.currency || ""),
      p_provider_ref: String(d.id ?? ""),
      p_raw: d,
    });
    if (error) throw new Error(error.message);
    return data;
  }
  if (d.status === "failed" || d.status === "reversed") {
    await db.rpc("payment_fail", { p_ref: reference });
    return { status: "failed" };
  }
  return { status: "pending" }; // abandoned / ongoing: nothing is created
}

const CHANNELS: Record<string, string[] | undefined> = { momo: ["mobile_money"], card: ["card"], bank: undefined };

async function initPay(d: { reference: string; amount: number; email: string }, channels?: string[], meta: Record<string, unknown> = {}) {
  const res = await paystack("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({
      email: d.email,
      amount: d.amount,          // pesewas, taken from the database, never from the browser
      currency: "GHS",
      reference: d.reference,
      callback_url: SITE || undefined,
      channels,
      metadata: meta,
    }),
  });
  if (!res?.status || !res?.data?.authorization_url) {
    await db.rpc("payment_fail", { p_ref: d.reference });
    return json({ error: "Could not start the payment. Please try again." }, 502);
  }
  return json({ reference: d.reference, url: res.data.authorization_url });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!PSK) return json({ error: "Payments are not configured yet." }, 503);

  const raw = await req.text();
  try {
    // ---- Paystack webhook ----
    const sig = req.headers.get("x-paystack-signature");
    if (sig) {
      if (!safeEq(await hmac512(raw), sig)) return new Response("bad signature", { status: 401 });
      const ev = JSON.parse(raw);
      if (ev?.event === "charge.success" && ev?.data?.reference) await settle(String(ev.data.reference));
      return new Response("ok", { status: 200 }); // always 200 for events we do not care about
    }

    // ---- browser actions ----
    const b = JSON.parse(raw || "{}");

    if (b.action === "preorder") {
      const { data, error } = await db.rpc("checkout_start", {
        p_name: b.name, p_phone: b.phone, p_email: b.email, p_method: b.method, p_product: String(b.product_id ?? ""),
      });
      if (error) return json({ error: clean(error.message) }, 400);
      return await initPay(data, CHANNELS[String(b.method)], { purpose: "preorder", product: data.title });
    }

    if (b.action === "deposit") {
      const amount = Math.round(Number(b.amount) * 100);
      if (!Number.isFinite(amount) || amount <= 0) return json({ error: "Enter a valid amount." }, 400);
      const { data, error } = await db.rpc("deposit_start", { p_k: String(b.k ?? ""), p_pin: String(b.pin ?? ""), p_amount: amount });
      if (error) return json({ error: clean(error.message) }, 400);
      const out = await initPay(data, undefined, { purpose: "deposit" });
      if (out.status !== 200) return out;
      const body = await out.json();
      return json({ ...body, fee: data.fee, net: data.net });
    }

    if (b.action === "verify") {
      const ref = String(b.reference ?? "");
      if (!/^x[pd][0-9a-f]{18}$/.test(ref)) return json({ error: "Bad reference." }, 400);
      await settle(ref);
      const { data } = await db.rpc("checkout_status", { p_ref: ref });
      return json(data);
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "Payment service error. Please try again." }, 500);
  }
});
