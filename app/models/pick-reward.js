import crypto from "node:crypto";

export function eligibleRewards(templates, orderTotal) {
  return templates.filter(
    (template) =>
      template.active &&
      template.weight > 0 &&
      orderTotal >= template.minOrderValue &&
      (!Number.isFinite(Number(template.maxIssued)) ||
        Number(template.maxIssued) <= 0 ||
        Number(template.issuedCount) < Number(template.maxIssued)),
  );
}

/** Pick an eligible active reward without leaking selection policy to callers. */
export function pickReward(templates, orderTotal) {
  const pool = eligibleRewards(templates, orderTotal);
  const totalWeight = pool.reduce((total, template) => total + template.weight, 0);
  if (!totalWeight) return null;

  let needle = crypto.randomInt(totalWeight);
  for (const template of pool) {
    needle -= template.weight;
    if (needle < 0) return template;
  }
  return pool.at(-1);
}
