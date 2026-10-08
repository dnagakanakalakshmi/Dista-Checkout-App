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
  const configuredCountries = parseConfiguredCountries(
    input?.shop?.metafield?.jsonValue,
    input?.shop?.metafield?.value,
  );
  const allowAllCountries = configuredCountries.has('ALL');

  /** @type {CartDeliveryOptionsTransformRunResult["operations"]} */
  const operations = [];

  input.cart.deliveryGroups.forEach((group) => {
    const destinationCountry = String(group.deliveryAddress?.countryCode || '').toUpperCase();

    if (
      !allowAllCountries &&
      configuredCountries.size > 0 &&
      !configuredCountries.has(destinationCountry)
    ) {
      return;
    }

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

/**
 * @param {unknown} jsonValue
 * @param {string | null | undefined} rawValue
 */
function parseConfiguredCountries(jsonValue, rawValue) {
  const parsedValue = Array.isArray(jsonValue)
    ? jsonValue
    : parseRawConfiguredCountries(jsonValue ?? rawValue);

  if (!Array.isArray(parsedValue)) {
    return new Set();
  }

  return new Set(
    parsedValue
      .map((countryCode) => String(countryCode || '').trim().toUpperCase())
      .filter(Boolean)
  );
}

/**
 * @param {string | null | undefined} rawValue
 */
function parseRawConfiguredCountries(rawValue) {
  if (!rawValue) {
    return [];
  }

  if (typeof rawValue === "object") {
    return Array.isArray(rawValue)
      ? rawValue
      : Array.isArray(rawValue.countries)
        ? rawValue.countries
        : [];
  }

  if (typeof rawValue !== "string") {
    return [];
  }

  try {
    const parsedOuter = JSON.parse(rawValue);
    return Array.isArray(parsedOuter)
      ? parsedOuter
      : Array.isArray(parsedOuter?.countries)
        ? parsedOuter.countries
        : [];
  } catch (error) {
    return [];
  }
}