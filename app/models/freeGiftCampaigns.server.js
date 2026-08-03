import prisma from "../db.server";

export const FREE_GIFT_NAMESPACE = "$app";
export const FREE_GIFT_CONFIG_KEY = "gift_campaign_config";
export const FREE_GIFT_DISCOUNT_ID_KEY = "free_gift_discount_id";
export const FREE_GIFT_DISCOUNT_TITLE = "Free Gift Campaigns";
export const FREE_GIFT_FUNCTION_TITLE = "free-gift";
export const FREE_GIFT_QUERY_VARIABLES_KEY = "freegift-collection-ids";
const DEFAULT_NOTIFICATION_TITLE = "You've unlocked free gifts!";
const API_VERSION = "2026-04";

const EMPTY_CONFIG = {
  version: 1,
  campaigns: [],
  freegiftCollectionIds: [],
  tags: [],
  notification: { enabled: false, title: DEFAULT_NOTIFICATION_TITLE },
};

export async function getFreeGiftConfig(admin) {
  const response = await admin.graphql(
    `#graphql
      query FreeGiftConfig {
        shop {
          id
          metafield(namespace: "$app", key: "gift_campaign_config") {
            value
            jsonValue
          }
          discountMetafield: metafield(namespace: "$app", key: "free_gift_discount_id") {
            value
          }
        }
      }`,
  );
  const json = await response.json();
  const shopId = json.data?.shop?.id;
  const config = normalizeConfig(readMetafieldJson(json.data?.shop?.metafield));

  return {
    shopId,
    config,
    discountId: json.data?.shop?.discountMetafield?.value || "",
  };
}

export async function saveFreeGiftConfig(admin, config, discountId = "") {
  const shopResponse = await admin.graphql(
    `#graphql
      query ShopId {
        shop { id }
      }`,
  );
  const shopJson = await shopResponse.json();
  const shopId = shopJson.data?.shop?.id;
  const normalized = normalizeConfig(config);

  const metafields = [
    {
      ownerId: shopId,
      namespace: FREE_GIFT_NAMESPACE,
      key: FREE_GIFT_CONFIG_KEY,
      type: "json",
      value: JSON.stringify(normalized),
    },
  ];

  if (discountId) {
    metafields.push({
      ownerId: shopId,
      namespace: FREE_GIFT_NAMESPACE,
      key: FREE_GIFT_DISCOUNT_ID_KEY,
      type: "single_line_text_field",
      value: discountId,
    });
  }

  const response = await admin.graphql(
    `#graphql
      mutation SaveFreeGiftConfig($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }`,
    { variables: { metafields } },
  );
  const json = await response.json();
  const errors = json.data?.metafieldsSet?.userErrors || [];
  if (errors.length) {
    throw new Response(
      `Failed to save free gift campaigns: ${errors.map((e) => e.message).join("; ")}`,
      { status: 500 },
    );
  }

  return normalized;
}

export async function ensureFreeGiftAutomaticDiscount(admin, existingDiscountId, config) {
  const functionsResponse = await admin.graphql(
    `#graphql
      query FreeGiftFunctions {
        shopifyFunctions(first: 50, apiType: "discount") {
          nodes { id title apiType }
        }
      }`,
  );
  const functionsJson = await functionsResponse.json();
  const functions = functionsJson.data?.shopifyFunctions?.nodes || [];
  const freeGiftFunction =
    functions.find((fn) => fn.title === FREE_GIFT_FUNCTION_TITLE) ||
    functions.find((fn) => fn.title?.toLowerCase().includes("free gift"));

  if (!freeGiftFunction?.id) {
    return { discountId: existingDiscountId, errors: ["Deploy the free-gift function extension before activating campaigns."] };
  }

  const input = buildAutomaticDiscountInput(config);

  if (existingDiscountId) {
    const updateResponse = await admin.graphql(
      `#graphql
        mutation UpdateFreeGiftDiscount($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) {
          discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
            automaticAppDiscount { discountId }
            userErrors { field message }
          }
        }`,
      { variables: { id: existingDiscountId, automaticAppDiscount: input } },
    );
    const updateJson = await updateResponse.json();
    const payload = updateJson.data?.discountAutomaticAppUpdate;
    const errors = payload?.userErrors || [];

    if (payload?.automaticAppDiscount?.discountId && !errors.length) {
      return { discountId: payload.automaticAppDiscount.discountId, errors: [] };
    }

    const staleId = errors.some((error) =>
      /not found|does not exist|no longer exists/i.test(error.message || ""),
    );
    if (!staleId) {
      // Real failure (bad input, permissions, etc.) — surface it rather than
      // silently spinning up a second automatic discount for the same shop.
      return { discountId: existingDiscountId, errors: errors.map((e) => e.message) };
    }
    // Only reaches create() below when the stored id is genuinely stale.
  }

  const createResponse = await admin.graphql(
    `#graphql
      mutation CreateFreeGiftDiscount($automaticAppDiscount: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
          automaticAppDiscount { discountId }
          userErrors { field message }
        }
      }`,
    { variables: { automaticAppDiscount: input } },
  );
  const createJson = await createResponse.json();
  const payload = createJson.data?.discountAutomaticAppCreate;
  const errors = payload?.userErrors || [];

  return {
    discountId: payload?.automaticAppDiscount?.discountId || existingDiscountId,
    errors: errors.map((error) => error.message),
  };
}

export async function evaluateFreeGiftCampaignsWithAdmin(admin, { subtotal, lines }) {
  const { config } = await getFreeGiftConfig(admin);
  const activeCampaigns = config.campaigns.filter((c) => c.enabled);

  if (!activeCampaigns.length || !lines.length) {
    return {
      ok: true,
      giftVariantIds: [],
      gifts: [],
      campaigns: [],
      notification: config.notification,
    };
  }

  const normalizedLines = lines.map((line) => ({
    ...line,
    merchandiseId: normalizeVariantGid(line.merchandiseId || line.variantId),
    lineSubtotal: Number(line.lineSubtotal || 0),
  }));
  const variantIds = [...new Set(normalizedLines.map((l) => l.merchandiseId).filter(Boolean))];
  const productFacts = await fetchCartProductFacts(admin, variantIds);
  const nonGiftLines = normalizedLines.filter((line) => !isAutoGiftLine(line));

  const matchedCampaigns = activeCampaigns.filter((campaign) =>
    campaignQualifies(campaign, nonGiftLines, productFacts, Number(subtotal || 0)),
  );

  // variantId -> campaignId, first matching campaign wins if a gift variant
  // happens to be shared across campaigns
  const seenVariants = new Set();
  const gifts = [];
  for (const campaign of matchedCampaigns) {
    for (const variantId of campaign.giftVariantIds || []) {
      if (seenVariants.has(variantId)) continue;
      seenVariants.add(variantId);
      gifts.push({ variantId, campaignId: campaign.id });
    }
  }

  return {
    ok: true,
    giftVariantIds: [...seenVariants],
    gifts,
    campaigns: matchedCampaigns.map((c) => ({ id: c.id, title: c.title })),
    notification: config.notification,
  };
}

// Old shop-based entrypoint becomes a thin wrapper (still used if you keep
// any server-side/background callers around):
export async function evaluateFreeGiftCampaigns({ shop, subtotal, lines }) {
  const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });
  if (!session?.accessToken) {
    return { ok: false, giftVariantIds: [], error: "No active session found for shop" };
  }
  const admin = makeAdminClient(shop, session.accessToken);
  return evaluateFreeGiftCampaignsWithAdmin(admin, { subtotal, lines });
}

export function normalizeConfig(config) {
  const campaigns = Array.isArray(config?.campaigns)
    ? config.campaigns.map(normalizeCampaign).filter(Boolean)
    : [];

  return {
    ...EMPTY_CONFIG,
    campaigns,
    freegiftCollectionIds: [
      ...new Set(campaigns.flatMap((campaign) => campaign.conditions.collectionIds || [])),
    ],
    tags: [
      ...new Set(campaigns.flatMap((campaign) => campaign.conditions.tags || [])),
    ],
    notification: normalizeNotification(config?.notification),
  };
}

function normalizeNotification(notification) {
  const title = String(notification?.title ?? "").trim();
  return {
    enabled: Boolean(notification?.enabled),
    title: title || DEFAULT_NOTIFICATION_TITLE,
  };
}

export function normalizeCampaign(campaign) {
  if (!campaign || typeof campaign !== "object") return null;

  return {
    id: campaign.id || `fg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: String(campaign.title || "Free Gift Campaign").trim(),
    enabled: Boolean(campaign.enabled),
    subtotalThreshold: Math.max(0, Number(campaign.subtotalThreshold || 0)),
    logic: campaign.logic === "AND" ? "AND" : "OR",
    giftVariantIds: uniqueStrings(campaign.giftVariantIds),
    giftProducts: Array.isArray(campaign.giftProducts) ? campaign.giftProducts : [],
    conditions: {
      productTypes: uniqueStrings(campaign.conditions?.productTypes),
      collectionIds: uniqueStrings(campaign.conditions?.collectionIds),
      collections: Array.isArray(campaign.conditions?.collections) ? campaign.conditions.collections : [],
      tags: uniqueStrings(campaign.conditions?.tags),
    },
  };
}

function isLineEligible(conditions, facts) {
  if (!facts) return false;
  if (conditions.productTypes.length) {
    const wanted = new Set(conditions.productTypes.map((t) => t.toLowerCase()));
    if (wanted.has((facts.productType || "").toLowerCase())) return true;
  }
  if (conditions.collectionIds.length) {
    const wanted = new Set(conditions.collectionIds);
    if (facts.collectionIds?.some((id) => wanted.has(id))) return true;
  }
  if (conditions.tags.length) {
    const wanted = new Set(conditions.tags.map((t) => t.toLowerCase()));
    if (facts.tags?.some((tag) => wanted.has(tag.toLowerCase()))) return true;
  }
  return false;
}

export function campaignQualifies(campaign, lines, productFacts, subtotal) {
  const threshold = Number(campaign.subtotalThreshold || 0);
  const conditions = campaign.conditions || {};
  const hasConditions = conditions.productTypes?.length || conditions.collectionIds?.length || conditions.tags?.length;

  if (!hasConditions) {
    return subtotal >= threshold;
  }

  const eligibleLines = lines.filter((line) => isLineEligible(conditions, productFacts[line.merchandiseId]));

  if (campaign.logic === "AND") {
    if (!eligibleLines.length) return false;
    const eligibleSubtotal = eligibleLines.reduce((sum, line) => sum + Number(line.lineSubtotal || 0), 0);
    return eligibleSubtotal >= threshold;
  }

  // OR
  return subtotal >= threshold || eligibleLines.length > 0;
}

function buildAutomaticDiscountInput(config) {
  const normalized = normalizeConfig(config);
  return {
    title: FREE_GIFT_DISCOUNT_TITLE,
    functionHandle: "free-gift",
    discountClasses: ["PRODUCT"],
    startsAt: new Date().toISOString(),
    combinesWith: {
      orderDiscounts: true,
      productDiscounts: true,
      shippingDiscounts: true,
    },
    metafields: [
      {
        namespace: FREE_GIFT_NAMESPACE,
        key: FREE_GIFT_CONFIG_KEY,
        type: "json",
        value: JSON.stringify(normalized),
      },
      {
        namespace: FREE_GIFT_NAMESPACE,
        key: FREE_GIFT_QUERY_VARIABLES_KEY,
        type: "json",
        value: JSON.stringify({
          freegiftCollectionIds: normalized.freegiftCollectionIds,
          tags: normalized.tags,
        }),
      },
    ],
  };
}

async function fetchCartProductFacts(admin, variantIds) {
  if (!variantIds.length) return {};

  const response = await admin.graphql(
    `#graphql
      query VariantProductFacts($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            product {
              id
              productType
              tags
              collections(first: 100) {
                nodes { id }
              }
            }
          }
        }
      }`,
    { variables: { ids: variantIds } },
  );
  const json = await response.json();

  if (json.errors) {
    console.error("VariantProductFacts GraphQL errors:", JSON.stringify(json.errors, null, 2));
  }

  const facts = {};
  (json.data?.nodes || []).forEach((node) => {
    if (!node?.id) return;
    facts[node.id] = {
      productId: node.product?.id || "",
      productType: node.product?.productType || "",
      tags: node.product?.tags || [],
      collectionIds: node.product?.collections?.nodes?.map((collection) => collection.id) || [],
    };
  });
  return facts;
}

function makeAdminClient(shop, accessToken) {
  return {
    async graphql(query, variables = {}) {
      const response = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });
      if (!response.ok) {
        throw new Error(`Shopify Admin API request failed: ${response.status}`);
      }
      return response.json();
    },
  };
}

function readMetafieldJson(metafield) {
  if (!metafield) return null;
  if (metafield.jsonValue) return metafield.jsonValue;
  if (!metafield.value) return null;
  try {
    return JSON.parse(metafield.value);
  } catch {
    return null;
  }
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function isAutoGiftLine(line) {
  return line.attributes?.some((attribute) => attribute.key === "_auto_gift" && attribute.value === "true");
}

function normalizeVariantGid(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("gid://shopify/ProductVariant/")) return raw;
  if (/^\d+$/.test(raw)) return `gid://shopify/ProductVariant/${raw}`;
  return raw;
}