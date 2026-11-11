import { authenticate } from "../shopify.server";
import { voidCardForOrder } from "../models/scratch.server";

export const action = async ({ request }) => {
  try {
    const { shop, payload } = await authenticate.webhook(request);
    await voidCardForOrder(shop, payload.id);
    return new Response();
  } catch (error) {
    console.error("Scratch card cancellation webhook failed", error);
    return new Response("Retry", { status: 500 });
  }
};
