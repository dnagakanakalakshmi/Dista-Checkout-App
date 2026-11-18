import { authenticate } from "../shopify.server";
import db from "../db.server";
import { verifyToken, resultFor } from "../models/scratch.server";
import { shopFromDest } from "../models/scratch-util.js";
import { scratchPage } from "../utils/scratch-page.server";

export const loader = async ({ request, params }) => {
  const { shop } = await authenticate.public.appProxy(request);
  const normalizedShop = shopFromDest(shop);
  const id = verifyToken(params.token);
  const card = id
    ? await db.scratchCard.findUnique({
        where: { id },
        include: { rewardTemplate: true },
      })
    : null;
  const authorizedCard = card?.shop === normalizedShop ? card : null;
  const config = authorizedCard
    ? await db.scratchConfig.findUnique({ where: { shop: authorizedCard.shop } })
    : null;
  return new Response(
    scratchPage({
      token: params.token,
      state: resultFor(authorizedCard),
      theme: config?.theme,
    }),
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
};
