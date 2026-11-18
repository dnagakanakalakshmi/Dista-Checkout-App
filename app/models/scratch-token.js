import crypto from "node:crypto";

const secret = () => process.env.SHOPIFY_API_SECRET || "";
export function signToken(cardId) {
  const key = secret();
  if (!key) throw new Error("SHOPIFY_API_SECRET is required to sign scratch-card tokens.");
  const signature = crypto.createHmac("sha256", key).update(cardId).digest("hex").slice(0, 24);
  return `${cardId}.${signature}`;
}
export function verifyToken(token) {
  const [cardId, supplied, ...rest] = String(token || "").split(".");
  const key = secret();
  if (!cardId || !supplied || rest.length || !key) return null;
  const expected = signToken(cardId).split(".")[1];
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? cardId : null;
}
