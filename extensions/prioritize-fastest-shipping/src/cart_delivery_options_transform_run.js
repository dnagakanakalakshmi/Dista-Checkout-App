// @ts-check

/**
 * @typedef {import("../generated/api").CartDeliveryOptionsTransformRunInput} CartDeliveryOptionsTransformRunInput
 * @typedef {import("../generated/api").CartDeliveryOptionsTransformRunResult} CartDeliveryOptionsTransformRunResult
 */

/**
 * @param {CartDeliveryOptionsTransformRunInput} input
 * @returns {CartDeliveryOptionsTransformRunResult}
 */
export function cartDeliveryOptionsTransformRun(input) {
  /** @type {CartDeliveryOptionsTransformRunResult["operations"]} */
  const operations = [];

  input.cart.deliveryGroups.forEach((group) => {

    const freeOptions = group.deliveryOptions.filter(
      (option) => Number(option.cost.amount) === 0
    );

    if (freeOptions.length === 0) return;

    /** @param {string | null | undefined} title */
    const priorityRank = (title) => {
      const name = String(title || "").toLowerCase();

      if (name.includes("priority")) return 3;
      if (name.includes("express")) return 2;
      if (name.includes("standard")) return 1;
      return 0;
    };

    freeOptions.sort((a, b) => priorityRank(b.title) - priorityRank(a.title));

    // Avoid no-op move operations to keep the transform idempotent.
    const fastestFreeHandle = freeOptions[0].handle;
    if (group.deliveryOptions[0]?.handle !== fastestFreeHandle) {
      operations.push({
        deliveryOptionMove: {
          deliveryOptionHandle: fastestFreeHandle,
          index: 0
        }
      });
    }

    // Hide remaining free options
    freeOptions.slice(1).forEach(option => {
      operations.push({
        deliveryOptionHide: {
          deliveryOptionHandle: option.handle
        }
      });
    });

  });

  return { operations };
}