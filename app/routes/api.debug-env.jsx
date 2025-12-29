// app/routes/api.debug-env.jsx
import { json } from "@remix-run/node";

export const loader = async () => {
  const dbUrl = process.env.DATABASE_URL || "NOT SET";
  // Mask password for safety
  const safeUrl = dbUrl.replace(/(mongodb(?:\+srv)?:\/\/.*:)(.*)(@)/, "$1*****$3");
  return json({ DATABASE_URL: safeUrl });
};