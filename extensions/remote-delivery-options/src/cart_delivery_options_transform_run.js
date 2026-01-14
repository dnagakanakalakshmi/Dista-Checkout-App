// @ts-check

/**
 * @typedef {import("../generated/api").CartDeliveryOptionsTransformRunInput} CartDeliveryOptionsTransformRunInput
 * @typedef {import("../generated/api").CartDeliveryOptionsTransformRunResult} CartDeliveryOptionsTransformRunResult
 */

/**
 * @type {CartDeliveryOptionsTransformRunResult}
 */
const NO_CHANGES = {
  operations: [],
};

/**
 * @param {CartDeliveryOptionsTransformRunInput} input
 * @returns {CartDeliveryOptionsTransformRunResult}
 */
export function cartDeliveryOptionsTransformRun(input) {

  // Get isRemote attribute from cart
  const isRemoteValue = input?.cart?.attribute?.value;
  const isRemote = isRemoteValue === 'true';

  const operations = [];
  let totalOptions = 0;

  // Process each delivery group
  const deliveryGroups = input?.cart?.deliveryGroups || [];
  for (const group of deliveryGroups) {
    const deliveryOptions = group?.deliveryOptions || [];
    totalOptions += deliveryOptions.length;
    
    for (const option of deliveryOptions) {
      const title = (option.title || '').toString();
      const hasRemoteInTitle = title.toLowerCase().includes('remote');

      // If isRemote is false, hide options with "Remote" in title
      // If isRemote is true, hide options WITHOUT "Remote" in title
      const shouldHide = isRemote ? !hasRemoteInTitle : hasRemoteInTitle;

      if (shouldHide) {
        operations.push({
          deliveryOptionHide: {
            deliveryOptionHandle: option.handle
          }
        });
      }
    }
  }

  // If isRemote is true and all options would be hidden, show all instead
  if (isRemote && operations.length === totalOptions) {
    return NO_CHANGES;
  }

  if (!isRemote && operations.length === totalOptions) {
    return NO_CHANGES;
  }

  if (operations.length === 0) {
    return NO_CHANGES;
  }

  return { operations };
};