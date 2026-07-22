import {
  DiscountClass,
  OrderDiscountSelectionStrategy,
  ProductDiscountSelectionStrategy,
} from '../generated/api';

const GIFT_VARIANT_ID = 'gid://shopify/ProductVariant/48343224385765'; // hardcode for now
const THRESHOLD = 1000; 

/**
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 */

/**
 * @param {RunInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  if (!input.cart.lines.length) {
    return { operations: [] };
  }

  const operations = [];
  
  // --- free gift line ---
  if (input.discount.discountClasses.includes(DiscountClass.Product)) {
    const giftCandidate = buildGiftCandidate(input.cart);
    if (giftCandidate) {
      operations.push({
        productDiscountsAdd: {
          candidates: [giftCandidate],
          selectionStrategy: ProductDiscountSelectionStrategy.First,
        },
      });
    }
  }

  return { operations };
}

function buildGiftCandidate(cart) {
  const giftLine = cart.lines.find(
    (line) =>
      line.merchandise?.id === GIFT_VARIANT_ID &&
      line.autoGiftAttribute?.value === 'true',
  );

  if (!giftLine) {
    return null;
  }

  const qualifyingSubtotal = cart.lines
    .filter((line) => line.id !== giftLine.id)
    .reduce((sum, line) => sum + Number(line.cost.subtotalAmount.amount), 0);

  if (qualifyingSubtotal < THRESHOLD) {
    return null;
  }

  return {
    message: 'Free Gift',
    targets: [{ cartLine: { id: giftLine.id, quantity: 1 } }],
    value: { percentage: { value: '100' } },
  };
}
