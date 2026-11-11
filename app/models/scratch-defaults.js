export const DEFAULT_SCRATCH_REWARDS = [
  { label: "10% OFF", type: "PERCENT", value: 10, weight: 50, minOrderValue: 0, maxIssued: null },
  { label: "₹50 OFF", type: "FIXED", value: 50, weight: 30, minOrderValue: 0, maxIssued: null },
  { label: "Free Shipping", type: "FREE_SHIPPING", value: 0, weight: 15, minOrderValue: 0, maxIssued: null },
  { label: "₹200 OFF", type: "FIXED", value: 200, weight: 4, minOrderValue: 1500, maxIssued: null },
  { label: "25% OFF", type: "PERCENT", value: 25, weight: 1, minOrderValue: 3000, maxIssued: 20 },
];

export function defaultRewardId(shop, label) {
  return `${shop}-${label}`;
}
