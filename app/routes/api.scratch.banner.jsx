import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    const image = await readFile(resolve(process.cwd(), "public", "scratch-reward-banner.jpg"));
    const headers = new Headers(CORS_HEADERS);
    headers.set("Content-Type", "image/jpeg");
    headers.set("Content-Length", String(image.byteLength));
    headers.set("Cache-Control", "public, max-age=3600");
    return new Response(request.method === "HEAD" ? null : image, { headers });
  } catch (error) {
    console.error("[scratch] banner image failed to load", error);
    return new Response("Banner image unavailable", {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "text/plain" },
    });
  }
};
