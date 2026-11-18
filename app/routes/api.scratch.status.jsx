import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server.js";
import { getCardForStorefront, signToken } from "../models/scratch.server.js";
import { resultFor, shopFromSessionToken, storefrontScratchUrl } from "../models/scratch-util.js";

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

async function authenticateAny(request) {
  try {
    return await authenticate.public.customerAccount(request);
  } catch (error) {
    if (error instanceof Response && error.status === 204) throw error;
    if (process.env.SCRATCH_DEBUG === "true") {
      console.info(
        "[scratch] customerAccount auth failed; trying checkout authentication",
        error instanceof Response ? `${error.status} ${error.statusText}` : error,
      );
    }
    return await authenticate.public.checkout(request);
  }
}

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    const { sessionToken, cors } = await authenticateAny(request);
    const orderId = new URL(request.url).searchParams.get("orderId");
    const shop = shopFromSessionToken(sessionToken);
    if (process.env.SCRATCH_DEBUG === "true") {
      console.info("[scratch] status lookup", { shop, orderId });
    }

    const card = await getCardForStorefront({
      shop,
      orderId,
      viewerSub: sessionToken.sub,
    });
    const payload = !card
      ? { card: null }
      : {
          card: {
            token: signToken(card.id),
            status: card.status,
            url: storefrontScratchUrl(card.shop, signToken(card.id)),
            ...resultFor(card),
          },
        };
    return cors(withCors(json(payload)));
  } catch (error) {
    if (error instanceof Response) return withCors(error);
    console.error("[scratch] status failed", error);
    return withCors(json({ card: null, error: "server_error" }, { status: 500 }));
  }
};
