import db from "../app/db.server.js";

const result = await db.scratchCard.updateMany({
  where: { status: { in: ["ISSUED", "REVEALED"] }, expiresAt: { lt: new Date() } },
  data: { status: "EXPIRED" },
});
console.log(`Marked ${result.count} scratch card(s) as expired.`);
await db.$disconnect();
