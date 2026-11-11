import { authenticate } from "../shopify.server";
import { markScratchCardRedeemed } from "../models/scratch.server";

export const action = async ({ request }) => {
  try {
    const { shop, payload } = await authenticate.webhook(request);
    const card = await markScratchCardRedeemed(shop, payload);
    console.log("[scratch] orders/create redemption result", { orderId: payload?.id, matched: Boolean(card) });
    return new Response();
  } catch (error) {
    console.error("Scratch card redemption webhook failed", error);
    return new Response("Retry", { status: 500 });
  }
};
