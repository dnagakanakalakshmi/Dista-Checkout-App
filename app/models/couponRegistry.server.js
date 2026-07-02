// app/models/couponRegistry.server.js
//
// Mirrors bulkBatch.server.js's registry pattern for single coupons.
// Instead of relying on discountNodes(first: 100) — which can miss
// recently-created coupons and silently drops anything whose title
// doesn't match parseDiscountTitle — we track known coupon discount IDs
// in a shop-level metafield and resolve them directly via nodes(ids:).

const REGISTRY_NAMESPACE = "$app";
const REGISTRY_KEY = "couponRegistry";
const MAX_COUPONS_RETAINED = 1000; // adjust as needed

const REGISTRY_OWNER_QUERY = `#graphql
  query CouponRegistry {
    shop {
      id
      metafield(namespace: "${REGISTRY_NAMESPACE}", key: "${REGISTRY_KEY}") {
        value
      }
    }
  }`;

export async function getCouponRegistry(admin) {
  const response = await admin.graphql(REGISTRY_OWNER_QUERY);
  const json = await response.json();
  const raw = json.data?.shop?.metafield?.value;
  const shopId = json.data?.shop?.id;

  if (!raw) return { shopId, discountIds: [] };

  try {
    const parsed = JSON.parse(raw);
    return { shopId, discountIds: Array.isArray(parsed.discountIds) ? parsed.discountIds : [] };
  } catch {
    return { shopId, discountIds: [] };
  }
}

async function writeCouponRegistry(admin, shopId, discountIds) {
  const trimmed = discountIds.slice(-MAX_COUPONS_RETAINED); // keep most recent

  const response = await admin.graphql(
    `#graphql
      mutation SetCouponRegistry($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }`,
    {
      variables: {
        metafields: [
          {
            ownerId: shopId,
            namespace: REGISTRY_NAMESPACE,
            key: REGISTRY_KEY,
            type: "json",
            value: JSON.stringify({ discountIds: trimmed }),
          },
        ],
      },
    },
  );

  const json = await response.json();
  const userErrors = json.data?.metafieldsSet?.userErrors || [];
  if (userErrors.length) {
    throw new Response(
      `Failed to save coupon registry: ${userErrors.map((e) => e.message).join("; ")}`,
      { status: 500 },
    );
  }
}

export async function addCouponToRegistry(admin, discountId) {
  const { shopId, discountIds } = await getCouponRegistry(admin);
  if (discountIds.includes(discountId)) return;
  await writeCouponRegistry(admin, shopId, [...discountIds, discountId]);
}

export async function removeCouponFromRegistry(admin, discountId) {
  const { shopId, discountIds } = await getCouponRegistry(admin);
  await writeCouponRegistry(admin, shopId, discountIds.filter((id) => id !== discountId));
}

/**
 * Resolves every known coupon ID directly via nodes(ids:), rather than
 * scanning discountNodes(first: 100). Drops (and cleans up the registry
 * entry for) any ID that no longer resolves — deleted outside the app.
 */
export async function reconcileCouponRegistry(admin) {
  const { shopId, discountIds } = await getCouponRegistry(admin);
  if (!discountIds.length) return [];

  const response = await admin.graphql(
    `#graphql
      query CouponRegistryLive($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on DiscountCodeNode {
            id
            discount: codeDiscount {
              __typename
              ... on DiscountCodeApp {
                title
                status
                endsAt
                usageLimit
                codes(first: 1) {
                  nodes { code }
                }
              }
            }
            metafield(namespace: "$app", key: "config") {
              value
              jsonValue
            }
          }
        }
      }`,
    { variables: { ids: discountIds } },
  );

  const json = await response.json();
  const nodes = json.data?.nodes || [];

  const validIds = [];
  const liveNodes = [];

  nodes.forEach((node, i) => {
    if (node && node.discount?.__typename === "DiscountCodeApp") {
      validIds.push(discountIds[i]);
      liveNodes.push(node);
    }
  });

  if (validIds.length !== discountIds.length) {
    await writeCouponRegistry(admin, shopId, validIds);
  }

  return liveNodes;
}

export async function removeCouponsFromRegistry(admin, discountIdsToRemove) {
  if (!discountIdsToRemove.length) return;

  const { shopId, discountIds } = await getCouponRegistry(admin);
  const toRemove = new Set(discountIdsToRemove);
  const next = discountIds.filter((id) => !toRemove.has(id));

  // Skip the write entirely if nothing actually changed.
  if (next.length === discountIds.length) return;

  await writeCouponRegistry(admin, shopId, next);
}

export { REGISTRY_NAMESPACE, REGISTRY_KEY };