import { authenticate } from "../shopify.server";
import { issueCardForOrder, markScratchCardRedeemed } from "../models/scratch.server";

export const action = async ({ request }) => {
  try {
    const { shop, payload } = await authenticate.webhook(request);
    const card = await markScratchCardRedeemed(shop, payload);
    console.log("[scratch] orders/paid redemption result", { orderId: payload?.id, matched: Boolean(card) });
    await issueCardForOrder(shop, payload);
    return new Response();
  } catch (error) {
    console.error("Scratch card paid webhook failed", error);
    return new Response("Retry", { status: 500 });
  }
};
