import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server.js";
import { getCustomerScratchRewards } from "../models/scratch.server.js";
import { shopFromSessionToken } from "../models/scratch-util.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  try {
    const { sessionToken, cors } = await authenticate.public.customerAccount(request);
    const shop = shopFromSessionToken(sessionToken);
    const rewards = await getCustomerScratchRewards(shop, sessionToken.sub);
    return cors(withCors(json({ rewards })));
  } catch (error) {
    if (error instanceof Response) return withCors(error);
    console.error("[scratch] rewards lookup failed", error);
    return withCors(json({ rewards: [], error: "server_error" }, { status: 500 }));
  }
};
