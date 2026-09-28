import {DiscountClass, DeliveryDiscountSelectionStrategy} from '../generated/api';

/**
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartDeliveryOptionsDiscountsGenerateRunResult} CartDeliveryOptionsDiscountsGenerateRunResult
 */

/**
 * @param {RunInput} input
 * @returns {CartDeliveryOptionsDiscountsGenerateRunResult}
 */
export function cartDeliveryOptionsDiscountsGenerateRun(input) {
  if (
    !input.cart.deliveryGroups.length ||
    !input.discount.discountClasses.includes(DiscountClass.Shipping)
  ) {
    return {operations: []};
  }

  const configurations = normalizeConfigurations(input.discount.metafield?.jsonValue);
  const shippingConfig = configurations.find(
    (configuration) =>
      configuration.discountType === 'free_shipping' ||
      configuration.discountType === 'shipping_percentage',
  );

  if (!shippingConfig || shippingConfig.discountValue <= 0) {
    return {operations: []};
  }

  const cartAttributeValue = input.cart.attribute?.value ?? null;
  if (!meetsCartAttributeCondition(shippingConfig, cartAttributeValue)) {
    return {operations: []};
  }

  const lines = annotateLines(input.cart.lines);
  const qualifyingLines = selectQualifyingLines(shippingConfig, lines);

  if (!qualifyingLines.length) {
    return {operations: []};
  }

  if (!meetsMinimumRequirement(shippingConfig, qualifyingLines)) {
    return {operations: []};
  }

  if (!meetsMaximumRequirement(shippingConfig, qualifyingLines)) {
    return {operations: []};
  }

  return {
    operations: [
      {
        deliveryDiscountsAdd: {
          selectionStrategy: DeliveryDiscountSelectionStrategy.All,
          candidates: input.cart.deliveryGroups.map((group) => ({
            message:
              shippingConfig.title ||
              (shippingConfig.discountType === 'free_shipping'
                ? 'Free shipping'
                : `${shippingConfig.discountValue}% off shipping`),
            targets: [{ deliveryGroup: { id: group.id } }],
            value: {
              percentage: { value: shippingConfig.discountValue },
            },
          })),
        },
      },
    ],
  };
}

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

// Mirrors annotateLines in the order discount function — only the fields
// this function actually needs (no productId-based "products" mode here
// since appliesTo for free shipping is checked at cart level, see note
// in selectQualifyingLines).
function annotateLines(rawLines) {
  return rawLines.map((line) => {
    const product = line.merchandise?.product ?? null;

    return {
      quantity: line.quantity,
      subtotal: parseMoney(line.cost.subtotalAmount.amount),
      productId: product?.id ?? null,
      inAnyCollection: Boolean(product?.inAnyCollection),
    };
  });
}

// Mirrors selectQualifyingLines in the order discount function.
function selectQualifyingLines(configuration, lines) {
  const appliesTo = configuration.appliesTo;

  if (!appliesTo || appliesTo.mode === 'all') {
    return lines;
  }

  if (appliesTo.mode === 'products') {
    const productIds = new Set(appliesTo.resourceIds);
    return lines.filter((line) => line.productId && productIds.has(line.productId));
  }

  if (appliesTo.mode === 'collections') {
    return lines.filter((line) => line.inAnyCollection);
  }

  return lines;
}

// Mirrors meetsMinimumRequirement in the order discount function.
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

// Mirrors meetsMaximumRequirement in the order discount function: the
// shipping discount is rejected once the qualifying total EXCEEDS the
// configured maximum. Without this, a maximumRequirement set on a
// free_shipping/shipping_percentage coupon (both jsx routes pass it
// through for every discount type) would be silently ignored here even
// though it's enforced on the order-discount path.
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

  // normalizeConfigurations — add discountValue extraction
  return rawDiscounts
    .filter((discount) => discount && typeof discount === 'object')
    .map((discount) => ({
      discountType: discount.discountType,
      discountValue: normalizeShippingDiscountValue(discount.discountType, discount.discountValue),
      title: typeof discount.title === 'string' ? discount.title.trim() : '',
      appliesTo: normalizeAppliesTo(discount.appliesTo),
      minimumRequirement: normalizeMinimumRequirement(discount.minimumRequirement),
      maximumRequirement: normalizeMaximumRequirement(discount.maximumRequirement),
      cartAttribute: normalizeCartAttribute(discount.cartAttribute),
    }));

  // new helper
  function normalizeShippingDiscountValue(discountType, rawValue) {
    if (discountType === 'free_shipping') return 100;
    const value = parseMoney(rawValue);
    if (value <= 0 || value > 100) return 0;
    return value;
  }
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

function parseMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}