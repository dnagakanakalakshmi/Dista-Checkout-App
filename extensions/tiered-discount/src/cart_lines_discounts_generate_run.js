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

  const candidates = [];

  for (const line of input.cart.lines) {
    const metafield = line.merchandise?.quantityDiscounts;

    if (!metafield?.value) continue;

    let tiers;

    try {
      const parsed = JSON.parse(metafield.value);
      tiers = parsed.tiers || [];
    } catch (e) {
      continue; // skip invalid JSON
    }

    if (!tiers.length) continue;

    let applicableIncrementPercent = 0;
    let bestTierQuantity = -1;

    for (const tier of tiers) {
      const tierQuantity = Number(tier?.quantity);
      const tierDiscount = Number(tier?.discount);

      if (!Number.isFinite(tierQuantity) || !Number.isFinite(tierDiscount)) {
        continue;
      }

      if (
        line.quantity >= tierQuantity &&
        tierQuantity >= bestTierQuantity
      ) {
        bestTierQuantity = tierQuantity;
        applicableIncrementPercent = tierDiscount;
      }
    }

    if (applicableIncrementPercent <= 0) continue;

    const compareAtPerQty = Number(line.cost?.compareAtAmountPerQuantity?.amount);
    const currentPerQty = Number(line.cost?.amountPerQuantity?.amount);

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
    const totalDiscountPercent = Math.min(
      roundedBaseDiscountPercent + applicableIncrementPercent,
      100,
    );

    const targetPricePerItem = truncateMoney(
      basePerQty * (1 - totalDiscountPercent / 100),
    );

    const incrementalAmountPerItem = roundMoney(
      currentPerQty - targetPricePerItem,
    );
    const cappedIncrementAmountPerItem = Math.min(
      Math.max(incrementalAmountPerItem, 0),
      currentPerQty,
    );

    if (cappedIncrementAmountPerItem > 0) {
      candidates.push({
        message: `EXTRA ${applicableIncrementPercent}% OFF`,
        targets: [
          {
            cartLine: {
              id: line.id,
            },
          },
        ],
        value: {
          fixedAmount: {
            amount: cappedIncrementAmountPerItem.toFixed(2),
            appliesToEachItem: true,
          },
        },
      });
    }
  }

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