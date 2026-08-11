// app/routes/apps.free-gift-campaigns.jsx
import { json } from "@remix-run/node";
import { unauthenticated } from "../shopify.server";
import { evaluateFreeGiftCampaignsWithAdmin } from "../models/freeGiftCampaigns.server";

function getCorsHeaders(request) {
  const origin = request?.headers?.get?.("origin") || "*";
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return new Response("Method not allowed", { status: 405 });
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

  const { shop, subtotal, lines, country } = body;

  if (!shop) {
    return json({ ok: false, giftVariantIds: [], error: "Missing shop" }, { status: 400, headers: corsHeaders });
  }

  try {
    const { admin } = await unauthenticated.admin(shop);

    // Storefront client is only needed for market-aware availability checks
    // (i.e. when a country is supplied, which the checkout extension does).
    // The theme cart script doesn't send one and falls back to Admin-API-only.
    let storefront = null;
    if (country) {
      try {
        ({ storefront } = await unauthenticated.storefront(shop));
      } catch (storefrontError) {
        console.error("Could not get storefront client, falling back to Admin API availability check:", storefrontError);
      }
    }

    const result = await evaluateFreeGiftCampaignsWithAdmin(admin, {
      subtotal: Number(subtotal || 0),
      lines: Array.isArray(lines) ? lines : [],
      country: country || null,
      storefront,
    });
    return json(result, { headers: corsHeaders });
  } catch (error) {
    console.error("Free gift campaign evaluation failed:", error);
    return json({ ok: false, giftVariantIds: [], error: error.message }, { status: 401, headers: corsHeaders });
  }
};