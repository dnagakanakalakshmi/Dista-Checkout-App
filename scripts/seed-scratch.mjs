import db from "../app/db.server.js";
import { DEFAULT_SCRATCH_REWARDS, defaultRewardId } from "../app/models/scratch-defaults.js";

const shop = process.argv[2];
if (!shop) throw new Error("Usage: node scripts/seed-scratch.mjs shop.myshopify.com");

await db.scratchConfig.upsert({ where: { shop }, update: { enabled: true }, create: { shop, enabled: true } });
for (const reward of DEFAULT_SCRATCH_REWARDS) {
  const id = defaultRewardId(shop, reward.label);
  await db.rewardTemplate.upsert({
    where: { id },
    update: { ...reward, active: true },
    create: { id, shop, ...reward, active: true },
  });
}
console.log(`Seeded scratch cards for ${shop}`);
await db.$disconnect();
