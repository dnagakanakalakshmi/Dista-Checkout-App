import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server.js";
import { revealCard } from "../models/scratch.server.js";
import { shopFromSessionToken } from "../models/scratch-util.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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
    return await authenticate.public.checkout(request);
  }
}

export const action = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    const { sessionToken } = await authenticateAny(request);
    const body = await request.json();
    const result = await revealCard(
      body?.token,
      sessionToken.sub,
      shopFromSessionToken(sessionToken),
    );
    return withCors(json(result));
  } catch (error) {
    if (error instanceof Response) return withCors(error);
    console.error("[scratch] extension reveal failed", error);
    return withCors(json({ state: "error" }, { status: 500 }));
  }
};
