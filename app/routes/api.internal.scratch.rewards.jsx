import crypto from "node:crypto";
import { json } from "@remix-run/node";
import { getCustomerScratchRewards } from "../models/scratch.server.js";
import { idOf, shopFromDest } from "../models/scratch-util.js";

function isAuthorized(request) {
  const secret = process.env.SCRATCH_INTERNAL_SECRET || "";
  const timestamp = request.headers.get("x-scratch-timestamp") || "";
  const supplied = request.headers.get("x-scratch-signature") || "";
  if (!secret || !timestamp || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(Date.now() - Number(timestamp)) > 60_000) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}:${request.headers.get("x-scratch-shop") || ""}:${request.headers.get("x-scratch-customer") || ""}`)
    .digest("hex");
  return supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export const loader = async ({ request }) => {
  if (!isAuthorized(request)) return json({ error: "Unauthorized" }, { status: 401 });
  const rawShop = request.headers.get("x-scratch-shop");
  const shop = shopFromDest(rawShop);
  const rawCustomerId = request.headers.get("x-scratch-customer");
  const customerId = idOf(rawCustomerId);
  console.log("[scratch] internal rewards lookup", {
    shop,
    customerId,
    hasCustomerId: Boolean(customerId),
  });
  const rewards = await getCustomerScratchRewards(shop, customerId);
  return json({ rewards });
};
