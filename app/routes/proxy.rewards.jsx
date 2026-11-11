import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getCustomerScratchRewards } from "../models/scratch.server";

export const loader = async ({ request }) => {
  try {
    const { shop, loggedInCustomerId } = await authenticate.public.appProxy(request);
    if (!shop || !loggedInCustomerId) return json({ rewards: [] });
    const rewards = await getCustomerScratchRewards(shop, loggedInCustomerId);
    return json({ rewards });
  } catch (error) {
    console.error("[scratch] proxy rewards lookup failed", error);
    return json({ rewards: [], error: "server_error" }, { status: 500 });
  }
};
