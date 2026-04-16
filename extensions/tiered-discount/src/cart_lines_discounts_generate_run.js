import {
  DiscountClass,
  ProductDiscountSelectionStrategy,
} from '../generated/api';

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function truncateMoney(value) {
  if (value >= 0) {
    return Math.floor(value * 100) / 100;
  }

  return Math.ceil(value * 100) / 100;
}


function hasOwn(obj, key) {
  return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeCountry(countryCode) {
  if (!countryCode) return null;
  return String(countryCode).trim().toUpperCase();
}

function parseLegacyVariantId(variantGid) {
  if (!variantGid) return null;

  const raw = String(variantGid).trim();
  if (!raw) return null;

  const tail = raw.split('/').pop();
  return tail || null;
}

function resolveTiersForScope(tiers, tiersByCountry, countryCode) {
  if (countryCode && hasOwn(tiersByCountry, countryCode)) {
    const countryTiers = tiersByCountry[countryCode];
    return Array.isArray(countryTiers) ? countryTiers : [];
  }

  if (hasOwn(tiersByCountry, 'default')) {
    const defaultTiers = tiersByCountry.default;
    return Array.isArray(defaultTiers) ? defaultTiers : [];
  }

  return Array.isArray(tiers) ? tiers : [];
}

function resolveMetafieldTiers(doc, variantKey, countryCode) {
  const variants = doc?.variants;
  const variantBlock =
    variantKey && variants && typeof variants === 'object'
      ? variants[variantKey]
      : undefined;

  const variantUsesOwnTierSource =
    Boolean(variantBlock) &&
    (variantBlock.tiers !== undefined ||
      variantBlock.tiers_by_country !== undefined);

  if (variantUsesOwnTierSource) {
    return {
      usedVariantScope: true,
      tiers: resolveTiersForScope(
        variantBlock.tiers,
        variantBlock.tiers_by_country,
        countryCode,
      ),
    };
  }

  return {
    usedVariantScope: false,
    tiers: resolveTiersForScope(
      doc?.tiers,
      doc?.tiers_by_country,
      countryCode,
    ),
  };
}

function getLineTiers(doc, variantId, countryCode) {
  const legacyVariantId = parseLegacyVariantId(variantId);
  const resolvedLegacy = resolveMetafieldTiers(
    doc,
    legacyVariantId,
    countryCode,
  );

  if (
    resolvedLegacy.usedVariantScope ||
    !variantId ||
    variantId === legacyVariantId
  ) {
    return resolvedLegacy.tiers;
  }

  const resolvedRawId = resolveMetafieldTiers(doc, variantId, countryCode);
  return resolvedRawId.usedVariantScope
    ? resolvedRawId.tiers
    : resolvedLegacy.tiers;
}

function getApplicableTier(tiers, lineQuantity) {
  let bestTier = null;
  let bestMinQty = -1;

  for (const tier of tiers) {
    const minQuantity = Number(tier?.min_quantity);
    const maxQuantity =
      tier?.max_quantity === null || tier?.max_quantity === undefined
        ? null
        : Number(tier.max_quantity);
    const discountValue = Number(tier?.discount_value);
    const discountType = String(tier?.discount_type || '').toLowerCase();

    if (
      !Number.isFinite(minQuantity) ||
      !Number.isFinite(discountValue) ||
      (maxQuantity !== null && !Number.isFinite(maxQuantity))
    ) {
      continue;
    }

    if (lineQuantity < minQuantity) continue;
    if (maxQuantity !== null && lineQuantity > maxQuantity) continue;

    if (minQuantity >= bestMinQty) {
      bestMinQty = minQuantity;
      bestTier = {
        discountType,
        discountValue,
      };
    }
  }

  return bestTier;
}

function getDiscountAmountPerItem(currentPerQty, tier) {
  if (
    !tier ||
    !Number.isFinite(currentPerQty) ||
    currentPerQty <= 0 ||
    !Number.isFinite(tier.discountValue) ||
    tier.discountValue <= 0
  ) {
    return 0;
  }

  if (tier.discountType === 'percentage') {
    return roundMoney((currentPerQty * tier.discountValue) / 100);
  }

  return roundMoney(tier.discountValue);
}

/**
 * @param {RunInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  if (!input.cart.lines.length) {
    return { operations: [] };
  }

  const hasProductDiscountClass = input.discount.discountClasses.includes(
    DiscountClass.Product,
  );

  if (!hasProductDiscountClass) {
    return { operations: [] };
  }

  const countryCode = normalizeCountry(input.localization?.country?.isoCode);
  const candidates = [];

  for (const line of input.cart.lines) {
    // only apply discount if product id is 9033187688610
    if (line.merchandise?.id !== '9033187688610') {
      continue;
    }

    const metafield = line.merchandise?.product?.quantityDiscounts;

    if (!metafield?.value) continue;

    let parsed;

    try {
      parsed = JSON.parse(metafield.value);
    } catch (e) {
      continue; // skip invalid JSON
    }

    const variantId = line.merchandise?.id;
    const tiers = getLineTiers(parsed, variantId, countryCode);

    if (!tiers.length) continue;

    const applicableTier = getApplicableTier(tiers, line.quantity);
    const currentPerQty = Number(line.cost?.amountPerQuantity?.amount);
    const compareAtPerQty = Number(
      line.cost?.compareAtAmountPerQuantity?.amount,
    );

    if (!Number.isFinite(currentPerQty) || currentPerQty <= 0) continue;

    const basePerQty =
      Number.isFinite(compareAtPerQty) && compareAtPerQty > 0
        ? compareAtPerQty
        : currentPerQty;

    const rawBaseDiscountPercent =
      ((basePerQty - currentPerQty) / basePerQty) * 100;
    const roundedBaseDiscountPercent = Math.round(
      Math.max(rawBaseDiscountPercent, 0),
    );

    const tierDiscountPercent =
      applicableTier?.discountType === 'percentage'
        ? applicableTier.discountValue
        : 0;

    const totalDiscountPercent = Math.min(
      roundedBaseDiscountPercent + tierDiscountPercent,
      100,
    );

    const targetPricePerItem = truncateMoney(
      basePerQty * (1 - totalDiscountPercent / 100),
    );

    const rawAmountPerItem = roundMoney(currentPerQty - targetPricePerItem);
    const cappedAmountPerItem = Math.min(
      Math.max(rawAmountPerItem, 0),
      currentPerQty,
    );

    if (cappedAmountPerItem > 0) {
      const candidateMessage =
        tierDiscountPercent > 0
          ? `EXTRA ${tierDiscountPercent}% OFF`
          : 'EXTRA DISCOUNT APPLIED';

      candidates.push({
        message: candidateMessage,
        targets: [
          {
            cartLine: {
              id: line.id,
            },
          },
        ],
        value: {
          fixedAmount: {
            amount: truncateMoney(cappedAmountPerItem).toFixed(2),
            appliesToEachItem: true,
          },
        },
      });
    }
  }

  // for (const line of input.cart.lines) {
  //   const bargainPriceValue = line.bargainPrice?.value;
  //   const originalPriceValue = line.originalPrice?.value;

  //   const bargainPrice = Number(bargainPriceValue);
  //   const originalPrice = Number(originalPriceValue);

  //   if (
  //     Number.isFinite(bargainPrice) &&
  //     Number.isFinite(originalPrice) &&
  //     originalPrice > 0 &&
  //     bargainPrice < originalPrice
  //   ) {
  //     const bargainDiscountPercent =
  //       ((originalPrice - bargainPrice) / originalPrice) * 100;

  //     if (bargainDiscountPercent <= 10) {
  //       const currentPerQty = Number(line.cost?.amountPerQuantity?.amount);
  //       const basePrice =
  //         Number.isFinite(currentPerQty) && currentPerQty > 0
  //           ? currentPerQty
  //           : originalPrice;
  //       const rawBargainAmount = roundMoney(
  //         (basePrice * bargainDiscountPercent) / 100,
  //       );
  //       const bargainAmountPerItem = Math.min(
  //         Math.max(rawBargainAmount, 0),
  //         basePrice,
  //       );

  //       if (bargainAmountPerItem > 0) {
  //         candidates.push({
  //           message: 'Bargain applied',
  //           targets: [
  //             {
  //               cartLine: {
  //                 id: line.id,
  //               },
  //             },
  //           ],
  //           value: {
  //             fixedAmount: {
  //               amount: bargainAmountPerItem.toFixed(2),
  //               appliesToEachItem: true,
  //             },
  //           },
  //         });

  //         // Keep bargain and tiered logic mutually exclusive for a cart line.
  //         continue;
  //       }
  //     }
  //   }
  // }

  if (!candidates.length) {
    return { operations: [] };
  }

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates,
          selectionStrategy:
            ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}