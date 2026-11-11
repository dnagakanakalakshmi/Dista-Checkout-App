import crypto from "node:crypto";

const secret = () => process.env.SHOPIFY_API_SECRET || "";
export function signToken(cardId) {
  const signature = crypto.createHmac("sha256", secret()).update(cardId).digest("hex").slice(0, 24);
  return `${cardId}.${signature}`;
}
export function verifyToken(token) {
  const [cardId, supplied, ...rest] = String(token || "").split(".");
  if (!cardId || !supplied || rest.length || !secret()) return null;
  const expected = signToken(cardId).split(".")[1];
  const a = Buffer.from(supplied); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? cardId : null;
}
