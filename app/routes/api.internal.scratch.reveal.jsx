import crypto from "node:crypto";
import { json } from "@remix-run/node";
import { revealCard } from "../models/scratch.server.js";

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

export const action = async ({ request }) => {
  if (!isAuthorized(request)) return json({ state: "invalid" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const result = await revealCard(body?.token, request.headers.get("x-scratch-customer"));
  return json(result);
};
