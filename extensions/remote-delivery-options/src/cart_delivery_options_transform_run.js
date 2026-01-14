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

      // If isRemote is true: hide options that DON'T have "remote"
      // If isRemote is false: hide options that HAVE "remote"
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

  // If all options would be hidden, show all instead (regardless of isRemote value)
  if (operations.length === totalOptions) {
    return NO_CHANGES;
  }

  if (operations.length === 0) {
    return NO_CHANGES;
  }

  return { operations };
};