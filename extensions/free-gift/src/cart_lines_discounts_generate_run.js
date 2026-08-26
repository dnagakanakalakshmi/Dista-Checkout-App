import {
  DiscountClass,
  ProductDiscountSelectionStrategy,
} from '../generated/api';

const AUTO_GIFT_KEY_VALUE = 'true';
const APPBREW_ATTRIBUTE_KEY = 'appbrew_instance_id';

/**
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 */

/**
 * @param {RunInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  if (!input.cart.lines.length || !input.discount.discountClasses.includes(DiscountClass.Product)) {
    return { operations: [] };
  }

  const config = input.discount.metafield?.jsonValue;

  // NEW: Appbrew checkout with the feature disabled — never discount,
  // regardless of what campaigns would otherwise qualify.
  const channelSettings = normalizeChannelSettings(config?.channelSettings);
  const appbrewAttributeValue = input.cart.attribute?.value;
  if (appbrewAttributeValue && !channelSettings.appbrewEnabled) {
    return { operations: [] };
  }

  const campaigns = normalizeCampaigns(config);
  if (!campaigns.length) {
    return { operations: [] };
  }

  const regularLines = input.cart.lines.filter((line) => !isAutoGiftLine(line));
  const subtotal = regularLines.reduce(
    (sum, line) => sum + Number(line.cost?.totalAmount?.amount || 0),
    0,
  );

  const qualifiedGiftVariantIds = new Set(
    campaigns
      .filter((campaign) => campaignQualifies(campaign, regularLines, subtotal))
      .flatMap((campaign) => campaign.giftVariantIds),
  );

  if (!qualifiedGiftVariantIds.size) {
    return { operations: [] };
  }

  const candidates = input.cart.lines
    .filter((line) =>
      isAutoGiftLine(line) &&
      qualifiedGiftVariantIds.has(line.merchandise?.id),
    )
    .map((line) => ({
      message: 'Free Gift',
      targets: [{ cartLine: { id: line.id, quantity: 1 } }],
      value: { percentage: { value: '100' } },
    }));

  if (!candidates.length) {
    return { operations: [] };
  }

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates,
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}

// NEW
function normalizeChannelSettings(channelSettings) {
  return {
    appbrewEnabled: Boolean(channelSettings?.appbrewEnabled),
  };
}

function normalizeCampaigns(config) {
  const campaigns = Array.isArray(config?.campaigns) ? config.campaigns : [];
  return campaigns
    .filter((campaign) => campaign?.enabled)
    .map((campaign) => ({
      subtotalThreshold: normalizeThreshold(campaign.subtotalThreshold),
      subtotalMax: normalizeThreshold(campaign.subtotalMax),
      logic: campaign.logic === 'AND' ? 'AND' : 'OR',
      giftVariantIds: uniqueStrings(campaign.giftVariantIds),
      conditions: {
        productTypes: uniqueStrings(campaign.conditions?.productTypes),
        collectionIds: uniqueStrings(campaign.conditions?.collectionIds),
        tags: uniqueStrings(campaign.conditions?.tags),
      },
    }))
    .filter((campaign) => campaign.giftVariantIds.length);
}

function normalizeThreshold(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  if (Number.isNaN(num)) return null;
  return num;
}

function isLineEligible(conditions, line) {
  const product = line.merchandise?.product;
  if (conditions.productTypes.length) {
    const wanted = new Set(conditions.productTypes.map((t) => t.toLowerCase()));
    if (wanted.has((product?.productType || "").toLowerCase())) return true;
  }
  if (conditions.collectionIds.length) {
    if (product?.inAnyCollection) return true;
  }
  if (conditions.tags.length) {
    const wanted = new Set(conditions.tags.map((t) => t.toLowerCase()));
    if (product?.hasTags?.some((r) => r.hasTag && wanted.has(r.tag.toLowerCase()))) return true;
  }
  return false;
}

function campaignQualifies(campaign, lines, subtotal) {
  const conditions = campaign.conditions;
  const min = campaign.subtotalThreshold;
  const max = campaign.subtotalMax;

  const results = [];

  const hasRange = (min !== null && min !== undefined) || (max !== null && max !== undefined);
  if (hasRange) {
    results.push(rangeSatisfied(min, max, subtotal));
  }

  const hasProductConditions =
    conditions.productTypes.length || conditions.collectionIds.length || conditions.tags.length;
  if (hasProductConditions) {
    const eligibleLines = lines.filter((line) => isLineEligible(conditions, line));
    results.push(eligibleLines.length > 0);
  }

  if (!results.length) return true;

  return campaign.logic === "AND" ? results.every(Boolean) : results.some(Boolean);
}

function rangeSatisfied(min, max, subtotal) {
  if (min === 0) return false;
  if (min !== null && min !== undefined && subtotal < min) return false;
  if (max !== null && max !== undefined && subtotal >= max) return false;
  return true;
}

function thresholdSatisfied(threshold, subtotal) {
  if (threshold === null || threshold === undefined) return true;
  if (threshold === 0) return false;
  return subtotal >= threshold;
}

function isAutoGiftLine(line) {
  return line.autoGiftAttribute?.value === AUTO_GIFT_KEY_VALUE;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}