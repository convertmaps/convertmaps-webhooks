// src/index.ts
// Token-only, provider-agnostic webhook → Supabase normalizer
// URL: /webhook/{workspace_id}/{node_id}/{token}

import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  WEBHOOK_BASE_URL?: string;
}

type NormalizedItem = {
  name?: string;
  quantity: number;
  unit_amount_cents: number;
  currency?: string;
  is_bump?: boolean;
};

type NormalizedEvent = {
  provider: "stripe" | "lemonsqueezy" | "paddle" | "shopify" | "custom";
  provider_event_id: string;
  provider_customer_id?: string;
  type: "purchase" | "opt_in" | "booking" | "quiz" | "custom";
  currency?: string;
  subtotal_cents?: number;
  discount_cents?: number;
  tax_cents?: number;
  total_cents: number;
  items_count: number;
  session_id?: string;
  visitor_id?: string;
  event_time: string; // ISO
  data?: Record<string, unknown>;
  items: NormalizedItem[];
};

// Limits
const MAX_BODY_BYTES = 64 * 1024;         // 64 KiB body cap
const MAX_ITEMS = 100;                    // max items per payload
const MAX_CENTS = 100_000_000;            // $1,000,000 cap per value
const MAX_EVENTS_PER_MIN = 300;           // per token per minute
const MAX_EVENTS_PER_MIN_PER_IP = 120;    // per IP per minute
const MAX_EVENT_AGE_DAYS = 7;             // reject very old events

// Simple in-memory buckets (per isolate)
const tokenBuckets = new Map<string, { ts: number; count: number }>();
const ipBuckets = new Map<string, { ts: number; count: number }>();

function allowToken(token: string): boolean {
  const minute = Math.floor(Date.now() / 60000);
  const key = `${token}:${minute}`;
  const prev = tokenBuckets.get(key);
  const count = (prev?.count || 0) + 1;
  tokenBuckets.set(key, { ts: minute, count });
  return count <= MAX_EVENTS_PER_MIN;
}

function allowIp(ip: string): boolean {
  const minute = Math.floor(Date.now() / 60000);
  const key = `${ip}:${minute}`;
  const prev = ipBuckets.get(key);
  const count = (prev?.count || 0) + 1;
  ipBuckets.set(key, { ts: minute, count });
  return count <= MAX_EVENTS_PER_MIN_PER_IP;
}

function getClientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "0.0.0.0";
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      // Require JSON
      if (!req.headers.get("content-type")?.toLowerCase().includes("application/json")) {
        return json({ error: "Content-Type must be application/json" }, 415);
      }

      // Enforce Content-Length if present
      const contentLength = Number(req.headers.get("content-length") || "0");
      if (contentLength > MAX_BODY_BYTES) {
        return json({ error: "Payload too large" }, 413);
      }

      // Expect: /webhook/{workspace_id}/{node_id}/{token}
      const parts = new URL(req.url).pathname.split("/").filter(Boolean);
      if (parts.length !== 4 || parts[0] !== "webhook") {
        return json({ error: "Not found" }, 404);
      }
      const [_, workspaceId, nodeId, token] = parts;

      // Soft rate limits
      const ip = getClientIp(req);
      if (!allowIp(ip)) return json({ error: "Too many requests (IP)" }, 429);
      if (!allowToken(token)) return json({ error: "Too many requests (token)" }, 429);

      const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

      // Validate node + workspace + token
      const { data: node, error: nodeErr } = await supabase
        .from("nodes")
        .select("id,funnel_id,webhook_token")
        .eq("id", nodeId)
        .single();
      if (nodeErr || !node) return json({ error: "Node not found" }, 404);

      const { data: funnel, error: funnelErr } = await supabase
        .from("funnels")
        .select("id,workspace_id")
        .eq("id", node.funnel_id)
        .single();
      if (funnelErr || !funnel || String(funnel.workspace_id) !== workspaceId) {
        return json({ error: "Workspace mismatch" }, 403);
      }
      if (!node.webhook_token || token !== node.webhook_token) {
        return json({ error: "Invalid token" }, 403);
      }

      // Read body
      const raw = await req.text();
      // Enforce true size limit if Content-Length was not set
      if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
        return json({ error: "Payload too large" }, 413);
      }

      // Parse JSON
      let payload: any;
      try {
        payload = JSON.parse(raw || "{}");
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }

      // Basic validation & caps
      if (typeof payload !== "object" || payload === null) {
        return json({ error: "Invalid JSON object" }, 400);
      }
      if (payload.items) {
        if (!Array.isArray(payload.items)) return json({ error: "items must be an array" }, 400);
        if (payload.items.length > MAX_ITEMS) return json({ error: "Too many items" }, 400);
      }
      const centsKeys = ["subtotal_cents", "discount_cents", "tax_cents", "total_cents"];
      for (const k of centsKeys) {
        if (payload[k] != null) {
          const v = Number(payload[k]);
          if (!Number.isInteger(v) || Math.abs(v) > MAX_CENTS) {
            return json({ error: `Invalid value for ${k}` }, 400);
          }
        }
      }

      // Normalize (no provider secrets)
      const norm = detectAndNormalize(payload);
      if (!norm) return json({ error: "Unsupported payload" }, 400);

      // Time sanity: reject very old events
      const evtMs = Date.parse(norm.event_time || "");
      if (!Number.isNaN(evtMs)) {
        const ageDays = (Date.now() - evtMs) / (1000 * 60 * 60 * 24);
        if (ageDays > MAX_EVENT_AGE_DAYS) {
          return json({ error: "Event too old" }, 422);
        }
      }

      // Validate items deeply
      if (norm.items?.length) {
        if (norm.items.length > MAX_ITEMS) return json({ error: "Too many items" }, 400);
        for (const it of norm.items) {
          if (!Number.isInteger(it?.unit_amount_cents || 0) || Math.abs(it.unit_amount_cents) > MAX_CENTS) {
            return json({ error: "Invalid unit_amount_cents" }, 400);
          }
          if (!Number.isInteger(it?.quantity || 0) || it.quantity < 1 || it.quantity > 1000) {
            return json({ error: "Invalid quantity" }, 400);
          }
        }
      }
      if (!Number.isInteger(norm.total_cents) || Math.abs(norm.total_cents) > MAX_CENTS) {
        return json({ error: "Invalid total_cents" }, 400);
      }

      // Upsert conversion via RPC (handles partitioned table conflict)
      const eventTimeISO = new Date(norm.event_time || new Date().toISOString()).toISOString();

      const { data: convRows, error: convErr } = await supabase.rpc("upsert_conversion", {
        p_workspace: workspaceId,
        p_funnel: node.funnel_id,
        p_node: nodeId,
        p_type: (norm.type || "purchase") as any,
        p_provider: norm.provider,
        p_provider_event_id: norm.provider_event_id || cryptoRandomId(),
        p_total_cents: norm.total_cents,
        p_event_time: eventTimeISO,
        p_provider_customer_id: norm.provider_customer_id || null,
        p_session_id: norm.session_id || null,
        p_visitor_id: norm.visitor_id || null,
        p_currency: norm.currency || null,
        p_subtotal_cents: norm.subtotal_cents ?? 0,
        p_discount_cents: norm.discount_cents ?? 0,
        p_tax_cents: norm.tax_cents ?? 0,
        p_items_count: norm.items_count ?? (Array.isArray(norm.items) ? norm.items.length : 0),
        p_data: norm.data || {}
      });
      if (convErr) return json({ error: convErr.message }, 500);

      let conversionId: string | null = null;
      let conversionEventTime: string | null = null;

      if (Array.isArray(convRows) && convRows.length) {
        conversionId = convRows[0].id as string;
        conversionEventTime = convRows[0].event_time as string;
      } else {
        // Duplicate → fetch existing by unique keys
        const { data: existing, error: existErr } = await supabase
          .from("conversions")
          .select("id,event_time")
          .eq("workspace_id", workspaceId)
          .eq("provider", norm.provider)
          .eq("provider_event_id", norm.provider_event_id)
          .eq("event_time", eventTimeISO)
          .single();
        if (existErr || !existing) return json({ error: existErr?.message || "Upsert failed" }, 500);
        conversionId = existing.id as string;
        conversionEventTime = existing.event_time as string;
      }

      // Map items to products via node_products
      const mappings = await fetchNodeProductMappings(supabase, workspaceId, nodeId);
      let mappedItems = mapItemsToProducts(norm.items || [], mappings, norm.currency || "USD");

      // Optional fallback: if no items provided, attribute total to primary product
      if ((!mappedItems || mappedItems.length === 0) && mappings?.length) {
        const primary = mappings.find(m => m.is_primary);
        if (primary) {
          mappedItems = [{
            name: "Order",
            quantity: 1,
            unit_amount_cents: norm.total_cents,
            currency: norm.currency || "USD",
            is_bump: false,
            // @ts-ignore add product_id for insert
            product_id: primary.product_id
          } as any];
        }
      }

      if (mappedItems.length > 0 && conversionId && conversionEventTime) {
        const rows = mappedItems.map(mi => ({
          workspace_id: workspaceId,
          conversion_id: conversionId!,
          conversion_event_time: conversionEventTime!,
          // @ts-ignore
          product_id: mi.product_id || null,
          name: mi.name || null,
          quantity: mi.quantity,
          unit_amount_cents: mi.unit_amount_cents,
          currency: mi.currency || norm.currency || "USD",
          is_bump: mi.is_bump ?? false
        }));
        const { error: itemsErr } = await supabase.from("conversion_items").insert(rows);
        if (itemsErr) return json({ error: itemsErr.message }, 500);
      }

      return new Response("ok", { status: 200, headers: corsHeaders() });
    } catch (err: any) {
      return json({ error: err?.message || "unknown" }, 500);
    }
  }
};

// ---------- Normalization (no provider secrets) ----------

function detectAndNormalize(p: any): NormalizedEvent | null {
  if (p?.object === "event" || (typeof p?.type === "string" && p.type.includes("."))) return normalizeStripeLoose(p);
  if (p?.alert_id || p?.event_time || p?.order_id) return normalizePaddleLoose(p);
  if (p?.meta?.event_name || p?.data?.attributes?.total) return normalizeLemonLoose(p);
  if (p?.line_items && (p?.total_price || p?.subtotal_price)) return normalizeShopifyLoose(p);
  if (p?.total_cents || p?.items) return normalizeCustom(p);
  return null;
}

function normalizeStripeLoose(evt: any): NormalizedEvent {
  const createdISO = evt?.created ? new Date(evt.created * 1000).toISOString() : new Date().toISOString();
  const id = evt?.id || cryptoRandomId();
  const o = evt?.data?.object || {};
  let totalCents = 0;
  let currency = "USD";
  let customer: string | undefined;

  if (evt?.type === "checkout.session.completed") {
    totalCents = Number(o.amount_total || 0);
    currency = (o.currency || "USD").toUpperCase();
    customer = o.customer || undefined;
  } else if (evt?.type === "payment_intent.succeeded") {
    totalCents = Number(o.amount || 0);
    currency = (o.currency || "USD").toUpperCase();
    customer = o.customer || undefined;
  } else if (evt?.type === "invoice.payment_succeeded") {
    totalCents = Number(o.total || 0);
    currency = (o.currency || "USD").toUpperCase();
    customer = o.customer || undefined;
  } else {
    totalCents = Number(o.amount_total || o.amount || 0);
    currency = (o.currency || "USD").toUpperCase();
    customer = o.customer || undefined;
  }

  return {
    provider: "stripe",
    provider_event_id: id,
    provider_customer_id: customer,
    type: "purchase",
    currency,
    total_cents: totalCents,
    items_count: 0,
    event_time: createdISO,
    items: []
  };
}

function normalizePaddleLoose(p: any): NormalizedEvent {
  const currency = (p?.currency || "USD").toUpperCase();
  const rawTotal = Number(p?.sale_gross || p?.total || p?.amount || 0);
  const total_cents = Math.round(rawTotal * (rawTotal < 1000 ? 100 : 1));
  return {
    provider: "paddle",
    provider_event_id: String(p?.event_id || p?.alert_id || cryptoRandomId()),
    type: "purchase",
    currency,
    total_cents,
    items_count: Array.isArray(p?.items) ? p.items.length : 0,
    event_time: p?.event_time || new Date().toISOString(),
    items: []
  };
}

function normalizeLemonLoose(p: any): NormalizedEvent {
  return {
    provider: "lemonsqueezy",
    provider_event_id: p?.meta?.event_id || cryptoRandomId(),
    type: "purchase",
    currency: (p?.data?.attributes?.currency || "USD").toUpperCase(),
    total_cents: Number(p?.data?.attributes?.total || 0),
    items_count: 0,
    event_time: p?.data?.attributes?.created_at || new Date().toISOString(),
    items: []
  };
}

function normalizeShopifyLoose(p: any): NormalizedEvent {
  const currency = (p?.currency || "USD").toUpperCase();
  const total_cents = Math.round(Number(p?.total_price || p?.subtotal_price || 0) * 100);
  const items = Array.isArray(p?.line_items)
    ? p.line_items.map((li: any) => ({
        name: li.title,
        quantity: Number(li.quantity || 1),
        unit_amount_cents: Math.round(Number(li.price) * 100) || 0,
        currency
      }))
    : [];
  return {
    provider: "shopify",
    provider_event_id: String(p?.id || cryptoRandomId()),
    type: "purchase",
    currency,
    total_cents,
    items_count: items.length,
    event_time: p?.created_at || new Date().toISOString(),
    items
  };
}

function normalizeCustom(payload: any): NormalizedEvent {
  return {
    provider: (payload?.provider || "custom") as any,
    provider_event_id: payload?.provider_event_id || payload?.id || cryptoRandomId(),
    type: (payload?.type || "purchase") as any,
    currency: (payload?.currency || "USD").toUpperCase(),
    subtotal_cents: Number(payload?.subtotal_cents || 0),
    discount_cents: Number(payload?.discount_cents || 0),
    tax_cents: Number(payload?.tax_cents || 0),
    total_cents: Number(payload?.total_cents || 0),
    items_count: Array.isArray(payload?.items) ? payload.items.length : 0,
    session_id: payload?.session_id,
    visitor_id: payload?.visitor_id,
    event_time: payload?.event_time || new Date().toISOString(),
    data: payload?.data || {},
    items: (payload?.items || []).map((i: any) => ({
      name: i.name,
      quantity: Number(i.quantity || 1),
      unit_amount_cents: Number(i.unit_amount_cents || 0),
      currency: (i.currency || payload?.currency || "USD").toUpperCase(),
      is_bump: !!i.is_bump
    }))
  };
}

// ---------- Product mapping ----------

async function fetchNodeProductMappings(
  supabase: SupabaseClient,
  workspaceId: string,
  nodeId: string
) {
  const { data, error } = await supabase
    .from("node_products")
    .select("product_id,is_primary,price_points_cents")
    .eq("workspace_id", workspaceId)
    .eq("node_id", nodeId);
  if (error || !data) return [];
  return data as Array<{ product_id: string; is_primary: boolean; price_points_cents: number[] | null }>;
}

function mapItemsToProducts(
  items: NormalizedItem[],
  mappings: Array<{ product_id: string; is_primary: boolean; price_points_cents: number[] | null }>,
  defaultCurrency: string
): Array<NormalizedItem & { product_id?: string }> {
  if (!items?.length) return [];
  const primary = mappings.find(m => m.is_primary);
  const tolerance = 0.05; // ±5%
  return items.map(it => {
    let product_id: string | undefined;
    const match = mappings.find(m => {
      if (!m.price_points_cents || !it.unit_amount_cents) return false;
      return m.price_points_cents.some(p => Math.abs(p - it.unit_amount_cents) <= Math.max(1, p * tolerance));
    });
    if (match) product_id = match.product_id;
    else if (primary) product_id = primary.product_id;
    return { ...it, product_id, currency: it.currency || defaultCurrency || "USD" };
  });
}

// ---------- Utils ----------

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}

function cryptoRandomId(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("");
}