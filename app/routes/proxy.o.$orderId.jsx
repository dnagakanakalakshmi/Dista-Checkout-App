import { authenticate } from "../shopify.server";
import { findCardForOrder, signToken } from "../models/scratch.server";
import { normalizeOrderId } from "../models/scratch-util";

export const loader = async ({ request, params }) => {
  const { shop } = await authenticate.public.appProxy(request);
  const orderId = normalizeOrderId(params.orderId);
  const card = await findCardForOrder(shop, orderId);
  return card
    ? Response.redirect(`/apps/scratch/${signToken(card.id)}`, 302)
    : new Response("Scratch card not found", { status: 404 });
};
