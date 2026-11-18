import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { revealCard } from "../models/scratch.server";

async function readToken(request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const body = await request.json().catch(() => ({}));
    return body?.token;
  }
  const form = await request.formData().catch(() => null);
  return form?.get("token");
}

export const action = async ({ request }) => {
  try {
    const { shop, loggedInCustomerId } = await authenticate.public.appProxy(request);
    const token = await readToken(request);
    return json(await revealCard(token, loggedInCustomerId, shop));
  } catch (error) {
    console.error("Scratch reveal failed", error);
    return json(
      { state: "error", error: "Could not reveal your card. Please retry." },
      { status: 500 },
    );
  }
};
