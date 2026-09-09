import prisma from "../db.server";

export const FREE_GIFT_NAMESPACE = "$app";
export const FREE_GIFT_CONFIG_KEY = "gift_campaign_config";
export const FREE_GIFT_DISCOUNT_ID_KEY = "free_gift_discount_id";
export const FREE_GIFT_DISCOUNT_TITLE = "Free Gift Campaigns";
export const FREE_GIFT_FUNCTION_TITLE = "free-gift";
export const FREE_GIFT_QUERY_VARIABLES_KEY = "freegift-collection-ids";
const DEFAULT_NOTIFICATION_TITLE = "You've unlocked free gifts!";
const API_VERSION = "2026-04";

const APPBREW_CART_ATTRIBUTE_KEY = "appbrew_instance_id";

const EMPTY_CONFIG = {
  version: 1,
  campaigns: [],
  freegiftCollectionIds: [],
  tags: [],
  notification: { enabled: false, title: DEFAULT_NOTIFICATION_TITLE },
  channelSettings: { appbrewEnabled: false }, // NEW
};

export async function getFreeGiftConfig(admin) {
  const response = await admin.graphql(
    `#graphql
      query FreeGiftConfig {
        shop {
          id
          currencyCode
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
    shopCurrencyCode: json.data?.shop?.currencyCode || null, // NEW
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

  if (payload?.automaticAppDiscount?.discountId && !errors.length) {
    return { discountId: payload.automaticAppDiscount.discountId, errors: [] };
  }

  // Create failed. If it failed specifically because a discount with this
  // title already exists on the shop, our stored id has been lost — find
  // the real one by title and update it instead of failing forever.
  const titleCollision = errors.some((error) => /unique/i.test(error.message || ""));
  if (titleCollision) {
    const recovered = await findExistingAutomaticDiscountId();
    if (recovered) {
      const updateResponse = await admin.graphql(
        `#graphql
          mutation UpdateFreeGiftDiscount($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) {
            discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
              automaticAppDiscount { discountId }
              userErrors { field message }
            }
          }`,
        { variables: { id: recovered, automaticAppDiscount: input } },
      );
      const updateJson = await updateResponse.json();
      const updatePayload = updateJson.data?.discountAutomaticAppUpdate;
      const updateErrors = updatePayload?.userErrors || [];
      return {
        discountId: updatePayload?.automaticAppDiscount?.discountId || recovered,
        errors: updateErrors.map((e) => e.message),
      };
    }
  }

  return {
    discountId: payload?.automaticAppDiscount?.discountId || existingDiscountId,
    errors: errors.map((error) => error.message),
  };

  async function findExistingAutomaticDiscountId() {
    const searchResponse = await admin.graphql(
      `#graphql
        query FindFreeGiftDiscount($query: String!) {
          automaticDiscountNodes(first: 5, query: $query) {
            nodes { id }
          }
        }`,
      { variables: { query: `title:'${FREE_GIFT_DISCOUNT_TITLE}'` } },
    );
    const searchJson = await searchResponse.json();
    return searchJson.data?.automaticDiscountNodes?.nodes?.[0]?.id || null;
  }
}

async function fetchGiftVariantAvailability(admin, variantIds) {
  if (!variantIds.length) return {};

  const response = await admin.graphql(
    `#graphql
      query GiftVariantAvailability($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            availableForSale
            inventoryPolicy
            inventoryQuantity
          }
        }
      }`,
    { variables: { ids: variantIds } },
  );
  const json = await response.json();

  if (json.errors) {
    console.error("GiftVariantAvailability GraphQL errors:", JSON.stringify(json.errors, null, 2));
  }

  const availability = {};
  (json.data?.nodes || []).forEach((node) => {
    if (!node?.id) return;
    availability[node.id] = isVariantAvailable(node);
  });
  return availability;
}

function isVariantAvailable(variant) {
  if (!variant.availableForSale) return false;
  if (variant.inventoryPolicy === "CONTINUE") return true; // overselling allowed
  return (variant.inventoryQuantity ?? 0) > 0;
}

export async function evaluateFreeGiftCampaignsWithAdmin(admin, { subtotal, lines, cartAttributes, countryCode }) {
  const { config, shopCurrencyCode } = await getFreeGiftConfig(admin);
  if (hasAppbrewCartAttribute(cartAttributes) && !config.channelSettings.appbrewEnabled) {
    return {
      ok: true,
      giftVariantIds: [],
      gifts: [],
      campaigns: [],
      notification: config.notification,
    };
  }
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
  const productFacts = await fetchCartProductFacts(admin, variantIds, countryCode, shopCurrencyCode);
  const nonGiftLines = normalizedLines.filter((line) => !isAutoGiftLine(line));

  const shopCurrencySubtotal = computeShopCurrencySubtotal(nonGiftLines, productFacts);

  const matchedCampaigns = activeCampaigns.filter((campaign) =>
    campaignQualifies(campaign, nonGiftLines, productFacts, shopCurrencySubtotal),
  );

  // SINGLE FREE GIFT with fallback: try matched campaigns in order; the
  // first one whose gift(s) are actually in stock wins. If a campaign's
  // gift is out of stock, fall through to the next matched campaign. If
  // none have anything in stock, no gift is given.
  let winningCampaign = null;
  let gifts = [];

  for (const campaign of matchedCampaigns) {
    const candidateVariantIds = [...new Set(campaign.giftVariantIds || [])];
    if (!candidateVariantIds.length) continue;

    const availability = await fetchGiftVariantAvailability(admin, candidateVariantIds);
    const candidateGifts = candidateVariantIds
      .filter((variantId) => availability[variantId])
      .map((variantId) => ({ variantId, campaignId: campaign.id }));

    if (candidateGifts.length) {
      winningCampaign = campaign;
      gifts = candidateGifts;
      break;
    }
  }

  return {
    ok: true,
    giftVariantIds: gifts.map((g) => g.variantId),
    gifts,
    campaigns: winningCampaign ? [{ id: winningCampaign.id, title: winningCampaign.title }] : [],
    notification: config.notification,
  };
}

// Old shop-based entrypoint becomes a thin wrapper (still used if you keep
// any server-side/background callers around):
export async function evaluateFreeGiftCampaigns({ shop, subtotal, lines, cartAttributes, countryCode }) {
  const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });
  if (!session?.accessToken) {
    return { ok: false, giftVariantIds: [], error: "No active session found for shop" };
  }
  const admin = makeAdminClient(shop, session.accessToken);
  return evaluateFreeGiftCampaignsWithAdmin(admin, { subtotal, lines, cartAttributes, countryCode });
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
    channelSettings: normalizeChannelSettings(config?.channelSettings), // NEW
  };
}

function normalizeChannelSettings(channelSettings) {
  return {
    appbrewEnabled: Boolean(channelSettings?.appbrewEnabled),
  };
}

// Accepts either the array form ({key, value}[]) sent by the checkout
// extension, or the object-map form ({key: value}) sent by cart.js on
// the storefront — both are valid shapes depending on the caller.
function hasAppbrewCartAttribute(cartAttributes) {
  if (!cartAttributes) return false;
  if (Array.isArray(cartAttributes)) {
    return cartAttributes.some(
      (attr) => attr?.key === APPBREW_CART_ATTRIBUTE_KEY && String(attr.value || "").trim(),
    );
  }
  return Boolean(String(cartAttributes[APPBREW_CART_ATTRIBUTE_KEY] || "").trim());
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
    subtotalThreshold: normalizeThreshold(campaign.subtotalThreshold),
    subtotalMax: normalizeThreshold(campaign.subtotalMax),
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

// null/undefined/"" => null ("not configured", no subtotal restriction)
// any other value => clamped 0-100000 (explicit 0 stays 0, meaning "can never qualify")
function normalizeThreshold(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  if (Number.isNaN(num)) return null;
  return Math.min(100000, Math.max(0, num));
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
  const conditions = campaign.conditions || {};
  const min = campaign.subtotalThreshold; // null | number
  const max = campaign.subtotalMax; // null | number

  const results = [];

  // Condition 1: subtotal range — only counts if merchant set min and/or max
  const hasRange = (min !== null && min !== undefined) || (max !== null && max !== undefined);
  if (hasRange) {
    results.push(rangeSatisfied(min, max, subtotal));
  }

  // Condition 2: product type / collection / tag — only counts if any are configured.
  // A line matches if it satisfies ANY configured product/collection/tag (unchanged
  // from before — that inner OR across type/collection/tag is untouched).
  const hasProductConditions =
    conditions.productTypes?.length || conditions.collectionIds?.length || conditions.tags?.length;
  if (hasProductConditions) {
    const eligibleLines = lines.filter((line) => isLineEligible(conditions, productFacts[line.merchandiseId]));
    results.push(eligibleLines.length > 0);
  }

  // No conditions configured at all -> unconditional gift (unchanged behavior)
  if (!results.length) return true;

  return campaign.logic === "AND" ? results.every(Boolean) : results.some(Boolean);
}

// min: null = no lower bound; 0 = explicitly typed 0, treated as impossible;
// >0 = subtotal must be >= min.
// max: null = no upper bound; otherwise subtotal must be strictly < max.
function rangeSatisfied(min, max, subtotal) {
  if (min === 0) return false;
  if (min !== null && min !== undefined && subtotal < min) return false;
  if (max !== null && max !== undefined && subtotal >= max) return false;
  return true;
}

// null = merchant never set a threshold => no subtotal restriction, always satisfied.
// 0 = merchant explicitly typed 0 => treated as impossible, per your earlier decision.
// >0 = normal comparison.
function thresholdSatisfied(threshold, subtotal) {
  if (threshold === null || threshold === undefined) return true;
  if (threshold === 0) return false;
  return subtotal >= threshold;
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

async function fetchCartProductFacts(admin, variantIds, countryCode, shopCurrencyCode) {
  if (!variantIds.length) return {};

  const response = await admin.graphql(
    `#graphql
      query VariantProductFacts($ids: [ID!]!, $context: ContextualPricingContext!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            contextualPricing(context: $context) {
              price { amount currencyCode }
            }
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
    {
      variables: {
        ids: variantIds,
        context: {
          ...(countryCode ? { country: countryCode } : {}),
          ...(shopCurrencyCode ? { presentmentCurrencyCode: shopCurrencyCode } : {}),
        },
      },
    },
  );
  const json = await response.json();

  if (json.errors) {
    console.error("VariantProductFacts GraphQL errors:", JSON.stringify(json.errors, null, 2));
  }

  const facts = {};
  (json.data?.nodes || []).forEach((node) => {
    if (!node?.id) return;
    facts[node.id] = {
      price: Number(node.contextualPricing?.price?.amount || 0), // normalized to shop currency
      productId: node.product?.id || "",
      productType: node.product?.productType || "",
      tags: node.product?.tags || [],
      collectionIds: node.product?.collections?.nodes?.map((collection) => collection.id) || [],
    };
  });
  return facts;
}

function computeShopCurrencySubtotal(lines, productFacts) {
  return lines.reduce((sum, line) => {
    const facts = productFacts[line.merchandiseId];
    const price = facts?.price || 0;
    return sum + price * Number(line.quantity || 0);
  }, 0);
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