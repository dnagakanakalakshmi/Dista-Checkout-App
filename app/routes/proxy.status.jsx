import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getCardForStorefront, signToken } from "../models/scratch.server";
import { storefrontScratchUrl } from "../models/scratch-util";

export const loader = async ({ request }) => {
  try {
    const { shop, loggedInCustomerId } = await authenticate.public.appProxy(request);
    const orderId = new URL(request.url).searchParams.get("orderId");
    const card = await getCardForStorefront({
      shop,
      orderId,
      viewerSub: loggedInCustomerId,
    });
    if (!card) return json({ card: null });
    const token = signToken(card.id);
    return json({
      card: {
        token,
        status: card.status,
        url: storefrontScratchUrl(card.shop, token),
      },
    });
  } catch (error) {
    console.error("Scratch proxy status failed", error);
    return json({ card: null }, { status: 401 });
  }
};
