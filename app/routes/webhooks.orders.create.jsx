import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  try {
    const { shop, payload } = await authenticate.webhook(request);
    if (process.env.SCRATCH_DEBUG === "true") {
      console.info("[scratch] ignoring legacy orders/create webhook", {
        shop,
        orderId: payload?.id,
      });
    }
    return new Response();
  } catch (error) {
    console.error("Legacy orders/create webhook failed", error);
    return new Response("Retry", { status: 500 });
  }
};
