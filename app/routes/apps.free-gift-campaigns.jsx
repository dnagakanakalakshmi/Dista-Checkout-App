// app/routes/apps.free-gift-campaigns.jsx
import { json } from "@remix-run/node";
import { unauthenticated } from "../shopify.server";
import { evaluateFreeGiftCampaignsWithAdmin } from "../models/freeGiftCampaigns.server";

function getCorsHeaders(request) {
  const origin = request?.headers?.get?.("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

export const action = async ({ request }) => {
  const corsHeaders = getCorsHeaders(request);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, giftVariantIds: [], error: "Invalid JSON body" }, { status: 400, headers: corsHeaders });
  }

  const { shop, subtotal, lines } = body;

  if (!shop) {
    return json({ ok: false, giftVariantIds: [], error: "Missing shop" }, { status: 400, headers: corsHeaders });
  }

  try {
    const { admin } = await unauthenticated.admin(shop);
    const result = await evaluateFreeGiftCampaignsWithAdmin(admin, {
      subtotal: Number(subtotal || 0),
      lines: Array.isArray(lines) ? lines : [],
    });
    return json(result, { headers: corsHeaders });
  } catch (error) {
    console.error("Free gift campaign evaluation failed:", error);
    return json({ ok: false, giftVariantIds: [], error: error.message }, { status: 401, headers: corsHeaders });
  }
};