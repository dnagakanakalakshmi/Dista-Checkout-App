import { authenticate } from "../shopify.server";
import db from "../db.server";
import { verifyToken, resultFor } from "../models/scratch.server";
import { scratchPage } from "../utils/scratch-page.server";

export const loader = async ({ request, params }) => {
  await authenticate.public.appProxy(request);
  const id = verifyToken(params.token);
  const card = id ? await db.scratchCard.findUnique({ where: { id }, include: { rewardTemplate: true } }) : null;
  const config = card ? await db.scratchConfig.findUnique({ where: { shop: card.shop } }) : null;
  return new Response(scratchPage({ token: params.token, state: resultFor(card), theme: config?.theme }), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
};
