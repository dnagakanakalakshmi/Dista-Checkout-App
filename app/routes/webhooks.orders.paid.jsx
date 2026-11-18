import { authenticate } from "../shopify.server";
import { issueCardForOrder, markScratchCardRedeemed } from "../models/scratch.server";

export const action = async ({ request }) => {
  try {
    const { shop, payload } = await authenticate.webhook(request);
    if (process.env.SCRATCH_DEBUG === "true") {
      console.info("[scratch] orders/paid webhook endpoint", {
        shop,
        orderId: payload?.id,
        configuredAppUrl: process.env.SHOPIFY_APP_URL || null,
        requestUrl: request.url,
        host: request.headers.get("host"),
        forwardedHost: request.headers.get("x-forwarded-host"),
        forwardedProto: request.headers.get("x-forwarded-proto"),
        webhookId: request.headers.get("x-shopify-webhook-id"),
      });
    }
    const card = await markScratchCardRedeemed(shop, payload);
    if (process.env.SCRATCH_DEBUG === "true") {
      console.info("[scratch] orders/paid redemption result", {
        orderId: payload?.id,
        matched: Boolean(card),
      });
    }
    await issueCardForOrder(shop, payload);
    return new Response();
  } catch (error) {
    console.error("Scratch card paid webhook failed", error);
    return new Response("Retry", { status: 500 });
  }
};
