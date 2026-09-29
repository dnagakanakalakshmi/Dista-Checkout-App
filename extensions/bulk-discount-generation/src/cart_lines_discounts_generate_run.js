import {
  DiscountClass,
  OrderDiscountSelectionStrategy,
} from '../generated/api';

/**
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 */

/**
 * @param {RunInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {

  if (!input.cart.lines.length || !input.discount.discountClasses.includes(DiscountClass.Order)) {
    return {operations: []};
  }


  // Cart amounts arrive in the buyer's presentment currency, while every
  // merchant-configured amount (fixed discount value, max cap, min/max
  // purchase amount) is stored in the store's currency. Convert the
  // configured amounts once up front so all comparisons and the discount
  // output below are in the cart's currency.
  const presentmentCurrencyRate = parsePresentmentCurrencyRate(input.presentmentCurrencyRate);

  const configurations = normalizeConfigurations(
    input.discount.metafield?.jsonValue,
  ).map((configuration) => toPresentmentCurrency(configuration, presentmentCurrencyRate));

  if (!configurations.length) {
    return {operations: []};
  }

  const lines = annotateLines(input.cart.lines);

  const currencyCode = input.cart.cost.subtotalAmount.currencyCode;
  const cartAttributeValue = input.cart.attribute?.value ?? null;

  const candidates = configurations
    .map((configuration) => buildCandidate(configuration, lines, currencyCode, cartAttributeValue))
    .filter(Boolean);


  if (!candidates.length) {
    return {operations: []};
  }


  return {
    operations: [
      {
        orderDiscountsAdd: {
          candidates,
          selectionStrategy: OrderDiscountSelectionStrategy.Maximum,
        },
      },
    ],
  };
}

// Pre-compute per-line data we need repeatedly: parsed cost and product id.
// Only ProductVariant merchandise has a `product` field in the union, so
// checking for `merchandise.product` directly is equivalent to checking
// __typename === 'ProductVariant', and doesn't depend on __typename being
// present in the resolved input (it isn't always echoed back, e.g. in some
// function-runner test payloads).
const AUTO_GIFT_VALUE = 'true';

function isAutoGiftLine(line) {
  return line?.autoGiftAttribute?.value === AUTO_GIFT_VALUE;
}

function annotateLines(rawLines) {
  return rawLines.map((line) => {
    const product = line.merchandise?.product ?? null;

    return {
      id: line.id,
      quantity: line.quantity,
      subtotal: parseMoney(line.cost.subtotalAmount.amount),
      productId: product?.id ?? null,
      inAnyCollection: Boolean(product?.inAnyCollection),
      isAutoGift: isAutoGiftLine(line),
    };
  });
}

// Cart attribute gate: "none" (no key configured) always passes — coupon
// applies regardless of cart attributes. "match" requires the attribute to
// be present on the cart; if a specific value was configured, it must match
// exactly, otherwise presence of the key alone is enough.
function meetsCartAttributeCondition(configuration, cartAttributeValue) {
  const cartAttribute = configuration.cartAttribute;

  if (!cartAttribute || cartAttribute.mode !== 'match') {
    return true;
  }

  if (cartAttributeValue === null || cartAttributeValue === undefined) {
    return false;
  }

  if (!cartAttribute.value) {
    return true;
  }

  return cartAttributeValue === cartAttribute.value;
}

function buildCandidate(configuration, lines, currencyCode, cartAttributeValue) {

  if (!meetsCartAttributeCondition(configuration, cartAttributeValue)) {
    return null;
  }

  const qualifyingLines = selectQualifyingLines(configuration, lines);

  if (!qualifyingLines.length) {
    return null;
  }

  if (!meetsMinimumRequirement(configuration, qualifyingLines)) {
    return null;
  }

  if (!meetsMaximumRequirement(configuration, qualifyingLines)) {
    return null;
  }

  const qualifyingSubtotal = qualifyingLines.reduce(
    (sum, line) => sum + line.subtotal,
    0,
  );

  const decimals = getCurrencyDecimals(currencyCode);
  const discountAmount = calculateDiscountAmount(configuration, qualifyingSubtotal, decimals);

  if (discountAmount <= 0) {
    return null;
  }

  // excludedCartLineIds = every line that is NOT a qualifying line, so the
  // discount only ever reduces the subtotal made up of qualifying lines.
  const qualifyingLineIds = new Set(qualifyingLines.map((line) => line.id));
  const excludedCartLineIds = lines
    .filter((line) => !qualifyingLineIds.has(line.id))
    .map((line) => line.id);

  const candidate = {
    message: buildMessage(configuration, discountAmount, currencyCode),
    targets: [
      {
        orderSubtotal: {
          excludedCartLineIds,
        },
      },
    ],
    value: buildDiscountValue(configuration, qualifyingSubtotal, discountAmount, decimals),
  };


  return candidate;
}

// Percentage coupons are sent to Shopify as a real percentage whenever the
// max-discount cap isn't the limiting factor. A percentage is currency-
// agnostic, so it avoids the shop-currency round-trip rounding Shopify
// applies to fixedAmount values in other currencies, and it renews
// correctly on subscription orders. A fixedAmount is only used where it's
// unavoidable: flat-amount coupons, and percentage coupons whose cap is
// actually binding for this cart.
function buildDiscountValue(configuration, qualifyingSubtotal, discountAmount, decimals) {
  if (configuration.discountType === 'percentage' && configuration.discountValue <= 100) {
    const uncappedAmount = qualifyingSubtotal * (configuration.discountValue / 100);
    const capBinds =
      configuration.maxDiscountAmount > 0 && uncappedAmount > configuration.maxDiscountAmount;

    if (!capBinds) {
      return {percentage: {value: configuration.discountValue}};
    }
  }

  return {fixedAmount: {amount: discountAmount.toFixed(decimals)}};
}

// Best-effort ISO 4217 minor-unit map. Anything not listed uses 2 decimals.
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
const THREE_DECIMAL_CURRENCIES = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

function getCurrencyDecimals(currencyCode) {
  if (ZERO_DECIMAL_CURRENCIES.has(currencyCode)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(currencyCode)) return 3;
  return 2;
}

// Filters lines down to the ones this configuration's "applies to" setting
// allows. mode "all" qualifies every line; "products"/"collections" qualify
// only lines whose product matches the stored resource ids.
function selectQualifyingLines(configuration, lines) {
  // Free gifts are not purchased items — they must not count toward
  // min/max quantity or amount, and they must not receive the coupon.
  const purchasedLines = lines.filter((line) => !line.isAutoGift);
  const appliesTo = configuration.appliesTo;

  if (!appliesTo || appliesTo.mode === 'all') {
    return purchasedLines;
  }

  if (appliesTo.mode === 'products') {
    const productIds = new Set(appliesTo.resourceIds);
    return purchasedLines.filter((line) => line.productId && productIds.has(line.productId));
  }

  if (appliesTo.mode === 'collections') {
    // inAnyCollection was resolved by Shopify against the $collectionIds
    // input query variable, which is populated from this discount's own
    // "$app:collection-ids" metafield — see shopify.extension.toml.
    return purchasedLines.filter((line) => line.inAnyCollection);
  }

  return purchasedLines;
}

// Checks the minimum purchase requirement against ONLY the qualifying lines,
// matching how Shopify's native "minimum requirement" semantics scope to the
// items the discount actually applies to.
function meetsMinimumRequirement(configuration, qualifyingLines) {
  const minimumRequirement = configuration.minimumRequirement;

  if (!minimumRequirement || minimumRequirement.mode === 'none') {
    return true;
  }

  if (minimumRequirement.mode === 'quantity') {
    const totalQuantity = qualifyingLines.reduce((sum, line) => sum + line.quantity, 0);
    return totalQuantity >= minimumRequirement.value;
  }

  if (minimumRequirement.mode === 'amount') {
    const totalAmount = qualifyingLines.reduce((sum, line) => sum + line.subtotal, 0);
    return totalAmount >= minimumRequirement.value;
  }

  return true;
}

// Mirror of meetsMinimumRequirement, but the discount is rejected once the
// qualifying total EXCEEDS the configured maximum (e.g. to keep a coupon
// scoped to small/medium orders only). Scoped to qualifying lines only, same
// as the minimum check.
function meetsMaximumRequirement(configuration, qualifyingLines) {
  const maximumRequirement = configuration.maximumRequirement;

  if (!maximumRequirement || maximumRequirement.mode === 'none') {
    return true;
  }

  if (maximumRequirement.mode === 'quantity') {
    const totalQuantity = qualifyingLines.reduce((sum, line) => sum + line.quantity, 0);
    return totalQuantity <= maximumRequirement.value;
  }

  if (maximumRequirement.mode === 'amount') {
    const totalAmount = qualifyingLines.reduce((sum, line) => sum + line.subtotal, 0);
    return totalAmount <= maximumRequirement.value;
  }

  return true;
}

function normalizeConfigurations(rawConfiguration) {
  if (!rawConfiguration || typeof rawConfiguration !== 'object') {
    return [];
  }

  const rawDiscounts = Array.isArray(rawConfiguration.discounts)
    ? rawConfiguration.discounts
    : [rawConfiguration];


  return rawDiscounts.map(normalizeConfiguration).filter(Boolean);
}

function normalizeConfiguration(rawDiscount) {
  if (!rawDiscount || typeof rawDiscount !== 'object') {
    return null;
  }

  const discountType = rawDiscount.discountType;
  const discountValue = parseMoney(rawDiscount.discountValue);
  const maxDiscountAmount = parseMoney(rawDiscount.maxDiscountAmount);

  if (!['percentage', 'fixed'].includes(discountType)) {
    return null;
  }
  if (discountValue <= 0) {
    return null;
  }
  if (maxDiscountAmount < 0) {
    return null;
  }

  return {
    discountType,
    discountValue,
    maxDiscountAmount,
    title: typeof rawDiscount.title === 'string' ? rawDiscount.title.trim() : '',
    appliesTo: normalizeAppliesTo(rawDiscount.appliesTo),
    minimumRequirement: normalizeMinimumRequirement(rawDiscount.minimumRequirement),
    maximumRequirement: normalizeMaximumRequirement(rawDiscount.maximumRequirement),
    cartAttribute: normalizeCartAttribute(rawDiscount.cartAttribute),
  };
}

function normalizeAppliesTo(rawAppliesTo) {
  if (!rawAppliesTo || typeof rawAppliesTo !== 'object') {
    return {mode: 'all', resourceIds: []};
  }

  const mode = rawAppliesTo.mode;

  if (mode !== 'products' && mode !== 'collections') {
    return {mode: 'all', resourceIds: []};
  }

  const resources = Array.isArray(rawAppliesTo.resources) ? rawAppliesTo.resources : [];
  const resourceIds = resources
    .map((resource) => (resource && typeof resource === 'object' ? resource.id : resource))
    .filter((id) => typeof id === 'string' && id.length > 0);

  if (!resourceIds.length) {
    return {mode: 'all', resourceIds: []};
  }

  return {mode, resourceIds};
}

function normalizeMinimumRequirement(rawMinimumRequirement) {
  if (!rawMinimumRequirement || typeof rawMinimumRequirement !== 'object') {
    return {mode: 'none', value: 0};
  }

  const mode = rawMinimumRequirement.mode;
  const value = parseMoney(rawMinimumRequirement.value);

  if ((mode !== 'quantity' && mode !== 'amount') || value <= 0) {
    return {mode: 'none', value: 0};
  }

  return {mode, value};
}

function normalizeMaximumRequirement(rawMaximumRequirement) {
  if (!rawMaximumRequirement || typeof rawMaximumRequirement !== 'object') {
    return {mode: 'none', value: 0};
  }

  const mode = rawMaximumRequirement.mode;
  const value = parseMoney(rawMaximumRequirement.value);

  if ((mode !== 'quantity' && mode !== 'amount') || value <= 0) {
    return {mode: 'none', value: 0};
  }

  return {mode, value};
}

function normalizeCartAttribute(rawCartAttribute) {
  if (!rawCartAttribute || typeof rawCartAttribute !== 'object') {
    return {mode: 'none', key: '', value: ''};
  }

  const key = typeof rawCartAttribute.key === 'string' ? rawCartAttribute.key.trim() : '';

  if (!key) {
    return {mode: 'none', key: '', value: ''};
  }

  const value = typeof rawCartAttribute.value === 'string' ? rawCartAttribute.value.trim() : '';
  return {mode: 'match', key, value};
}

function calculateDiscountAmount(configuration, subtotal, decimals = 2) {
  const rawDiscount =
    configuration.discountType === 'percentage'
      ? subtotal * (configuration.discountValue / 100)
      : configuration.discountValue;

  // 0 means "no cap" — only clamp against maxDiscountAmount when it's set.
  const candidates = [rawDiscount, subtotal];
  if (configuration.maxDiscountAmount > 0) {
    candidates.push(configuration.maxDiscountAmount);
  }

  return roundToCurrency(Math.min(...candidates), decimals);
}

function buildMessage(configuration, discountAmount, currencyCode) {
  const decimals = getCurrencyDecimals(currencyCode);
  const discountLabel =
    configuration.discountType === 'percentage'
      ? `${formatNumber(configuration.discountValue)}% off`
      : `${currencyCode} ${formatNumber(configuration.discountValue, decimals)} off`;
  const cappedLabel =
    configuration.maxDiscountAmount > 0
      ? ` up to ${currencyCode} ${formatNumber(configuration.maxDiscountAmount, decimals)}`
      : '';
  const appliedLabel = `applied ${currencyCode} ${formatNumber(discountAmount, decimals)}`;
  const baseMessage = configuration.title || `${discountLabel}${cappedLabel}`;

  return `${baseMessage} (${appliedLabel})`;
}

// Falls back to 1 (no conversion) if the rate is missing or invalid, e.g.
// if the input query doesn't request presentmentCurrencyRate yet.
function parsePresentmentCurrencyRate(rawRate) {
  const rate = Number(rawRate);
  return Number.isFinite(rate) && rate > 0 ? rate : 1;
}

// Percentages and quantities are currency-agnostic; only money amounts are
// scaled: the flat discount value (fixed type), the max discount cap, and
// amount-mode minimum/maximum purchase requirements.
function toPresentmentCurrency(configuration, rate) {
  return {
    ...configuration,
    discountValue:
      configuration.discountType === 'fixed'
        ? configuration.discountValue * rate
        : configuration.discountValue,
    // 0 still means "no cap".
    maxDiscountAmount: configuration.maxDiscountAmount * rate,
    minimumRequirement: convertRequirement(configuration.minimumRequirement, rate),
    maximumRequirement: convertRequirement(configuration.maximumRequirement, rate),
  };
}

function convertRequirement(requirement, rate) {
  if (!requirement || requirement.mode !== 'amount') {
    return requirement;
  }

  return {...requirement, value: requirement.value * rate};
}

function parseMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function roundToCurrency(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function formatNumber(value, decimals = 2) {
  return roundToCurrency(value, decimals).toFixed(decimals).replace(/\.0+$/, '');
}