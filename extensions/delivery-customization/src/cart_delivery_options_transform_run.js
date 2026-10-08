// @ts-nocheck

const NO_CHANGES = { operations: [] };

/** @param {any} input */
/** @returns {any} */
export function cartDeliveryOptionsTransformRun(input) {
  const now = getNextBusinessDay(
    input?.shop?.localTime?.date
      ? new Date(input.shop.localTime.date)
      : new Date()
  );

  const shopConfig = parseJson(
    input?.shop?.metafield?.jsonValue ??
    input?.shop?.metafield?.value
  ) || {};

  const shopSettings = {
    readyToShipRegularRange: parseShopDispatchRange(
      input?.shop?.readyToShipRegular?.jsonValue ??
      input?.shop?.readyToShipRegular?.value
    ),

    readyToShipOnlineRange: parseShopDispatchRange(
      input?.shop?.readyToShipOnlineOrders?.jsonValue ??
      input?.shop?.readyToShipOnlineOrders?.value
    ),

    fallbackRange: parseShopDispatchRange(
      input?.shop?.fallbackDispatchDays?.jsonValue ??
      input?.shop?.fallbackDispatchDays?.value
    ) || { min: 5, max: 6 }
  };

  const templates = Array.isArray(shopConfig.templates) ? shopConfig.templates : [];
  const compiledTemplates = compileTemplates(templates);
  const replacementFormat = shopConfig.replacementFormat || "Estimated Delivery: {label}";
  const countries = Array.isArray(shopConfig.countries)
    ? shopConfig.countries.map(c => String(c).toUpperCase().trim())
    : [];
  const allowAllCountries = countries.includes("ALL");

  const groups = input?.cart?.deliveryGroups || [];
  const allLines = input?.cart?.lines || [];
  const operations = [];
  const lineDataByCountry = new Map();

  for (const group of groups) {
    const countryCode = String(group?.deliveryAddress?.countryCode || "").toUpperCase();
    const isAllowed =
      countries.length > 0
        ? allowAllCountries || countries.includes(countryCode)
        : countryCode === "GB";

    if (!isAllowed) continue;

    let lineData = lineDataByCountry.get(countryCode);
    if (!lineData) {
      lineData = getLineDeliveryData(allLines, countryCode, shopSettings);
      lineDataByCountry.set(countryCode, lineData);
    }
    const { readyMin, readyMax, overallMinStart, overallMaxEnd } = getReadyDays(lineData, shopSettings);

    for (const option of group.deliveryOptions || []) {
      const title = String(option.title || "");
      const parsedDays =
        parseDaysFromTemplates(title, compiledTemplates) ||
        parseShippingDaysFromText(title) ||
        { min: 3, max: 5 };

      const deliveryMinDays = readyMin + parsedDays.min;
      const deliveryMaxDays = readyMax + parsedDays.max;
      let displayStart = addBusinessDays(now, deliveryMinDays);
      let displayEnd = addBusinessDays(now, deliveryMaxDays);
      if (overallMinStart && overallMaxEnd) {
        displayStart = overallMinStart;
        displayEnd = overallMaxEnd;
      }

      const displayLabel = `${formatDateShort(displayStart)} - ${formatDateShort(displayEnd)}`;
      const newTitle = buildUpdatedTitle(title, parsedDays.match, replacementFormat, displayLabel);

      operations.push({
        deliveryOptionRename: {
          deliveryOptionHandle: option.handle,
          title: newTitle
        }
      });
    }
  }

  return operations.length ? { operations } : NO_CHANGES;
}

/* ---------------- HELPERS ---------------- */

function parseShopDispatchRange(rawValue) {
  const parsed = parseJson(rawValue);

  if (!parsed) return null;

  const min = toNumberSafe(
    parsed.delivery_min_days ??
    parsed.minDays ??
    parsed.min
  );

  const max = toNumberSafe(
    parsed.delivery_max_days ??
    parsed.maxDays ??
    parsed.max
  );

  if (min === 0 && max === 0) {
    return null;
  }

  return { min, max };
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getNextBusinessDay(date) {
  const d = new Date(date);
  d.setDate(d.getDate() + 1);

  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }

  return d;
}

const MAX_BUSINESS_DAYS = 120;

function addBusinessDays(start, days) {
  const d = new Date(start);
  let added = 0;
  const target = Math.max(0, Math.min(Number(days) || 0, MAX_BUSINESS_DAYS));

  if (d.getDay() !== 0 && d.getDay() !== 6) {
    added = 1;
  }

  while (added < target) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();

    if (day !== 0 && day !== 6) {
      added++;
    }
  }

  return d;
}

function formatDateShort(date) {
  const d = new Date(date);
  const months = [
    "Jan","Feb","Mar","Apr","May","Jun",
    "Jul","Aug","Sep","Oct","Nov","Dec"
  ];

  return `${months[d.getMonth()]} ${d.getDate()}`;
}

function toNumberSafe(v) {
  if (v == null) return 0;

  const n = Number(String(v).replace(/,/g, ""));
  return Number.isNaN(n) ? 0 : n;
}

function parseVariantReadyValue(rawVal) {
  const parsed = parseJson(rawVal) ?? rawVal;

  if (typeof parsed === "number") {
    return { min: parsed, max: parsed };
  }

  if (typeof parsed === "string") {
    const n = Number(parsed);

    if (!isNaN(n)) {
      return { min: n, max: n };
    }

    const d = new Date(parsed);

    if (!isNaN(d)) {
      return {
        startISO: d.toISOString(),
        endISO: d.toISOString()
      };
    }
  }

  if (parsed && typeof parsed === "object") {
    const startRaw =
      parsed.start ??
      parsed.start_date ??
      parsed.min_date ??
      parsed.from ??
      parsed.min_ready_to_ship_date ??
      null;

    const endRaw =
      parsed.end ??
      parsed.end_date ??
      parsed.max_date ??
      parsed.to ??
      parsed.max_ready_to_ship_date ??
      null;

    const s = startRaw ? new Date(startRaw) : null;
    const e = endRaw ? new Date(endRaw) : null;

    return {
      min: toNumberSafe(parsed.min ?? parsed.min_ready_to_ship_days),
      max: toNumberSafe(parsed.max ?? parsed.max_ready_to_ship_days),
      startISO: s && !isNaN(s) ? s.toISOString() : null,
      endISO: e && !isNaN(e) ? e.toISOString() : null
    };
  }

  return null;
}

function parseRapidDeliveryEligible(rawVal, countryCode) {
  const parsed = parseJson(rawVal);

  if (!parsed || !countryCode) return false;

  if (countryCode === "US") {
    return Boolean(
      parsed["United States"] ??
      parsed.US ??
      parsed.us
    );
  }

  return Boolean(
    parsed[countryCode] ??
    parsed[countryCode.toLowerCase()]
  );
}

/**
 * rapid → variant metafield → tag-based (Online Product → ready_to_ship_online_orders,
 * else ready_to_ship_regular, IF that metafield is set) → global shop fallback.
 * Tier 3 is no longer gated on dispatch_days_source (unreachable from a Function) —
 * it's applied whenever the underlying metafields exist, and just falls through
 * to tier 4 when they don't.
 */
function getLineDispatchRange(line, countryCode, shopSettings) {
  const rapidEligible = parseRapidDeliveryEligible(
    line?.merchandise?.rapidDeliveryEligible?.jsonValue ??
    line?.merchandise?.rapidDeliveryEligible?.value,
    countryCode
  );
  if (countryCode === "US" && rapidEligible) {
    return { min: 1, max: 1 };
  }

  const variantRange = parseVariantReadyValue(
    line?.merchandise?.metafield?.jsonValue ??
    line?.merchandise?.metafield?.value
  );
  if (variantRange && (variantRange.min != null || variantRange.max != null)) return variantRange;

  const hasOnlineTag = Boolean(
    line?.merchandise?.product?.hasTags?.find(t => t.tag === "Online Product")?.hasTag
  );

  if (hasOnlineTag && shopSettings.readyToShipOnlineRange) return shopSettings.readyToShipOnlineRange;
  if (shopSettings.readyToShipRegularRange) return shopSettings.readyToShipRegularRange;
  return shopSettings.fallbackRange;
}

function getLineDeliveryData(lines, countryCode, shopSettings) {
  return lines.map(line => ({
    parsed: getLineDispatchRange(
      line,
      countryCode,
      shopSettings
    ),

    hasOnlineProductTag: Boolean(
      line?.merchandise?.product?.hasTags?.find(
        t => t.tag === "Online Product"
      )?.hasTag
    )
  }));
}

function getReadyDays(lineData, shopSettings) {
  let highestMax = 0;
  let correspondingMin = 0;

  let overallMinStart = null;
  let overallMaxEnd = null;

  let anyMissing = false;

  for (const line of lineData) {
    const d = line.parsed;

    if (!d) {
      anyMissing = true;
      continue;
    }

    if (d.max > highestMax) {
      highestMax = d.max;
      correspondingMin = d.min;
    }

    if (d.startISO) {
      const s = new Date(d.startISO);

      if (!overallMinStart || s < overallMinStart) {
        overallMinStart = s;
      }
    }

    if (d.endISO) {
      const e = new Date(d.endISO);

      if (!overallMaxEnd || e > overallMaxEnd) {
        overallMaxEnd = e;
      }
    }
  }

  // If every variant has its own dispatch range,
  // use the variant-level result.
  if (!anyMissing && highestMax > 0) {
    return {
      readyMin: correspondingMin,
      readyMax: highestMax,
      overallMinStart,
      overallMaxEnd
    };
  }

  // Product/shop-level fallback. Ranges were parsed once up front.
  const regularMin = shopSettings.readyToShipRegularRange?.min || 0;
  const regularMax = shopSettings.readyToShipRegularRange?.max || 0;
  const onlineMin = shopSettings.readyToShipOnlineRange?.min || 0;
  const onlineMax = shopSettings.readyToShipOnlineRange?.max || 0;

  const hasOnlineProduct = lineData.some(
    line => line.hasOnlineProductTag
  );

  if (
    hasOnlineProduct &&
    onlineMin > 0 &&
    onlineMax > 0
  ) {
    return {
      readyMin: onlineMin,
      readyMax: onlineMax,
      overallMinStart,
      overallMaxEnd
    };
  }

  if (regularMin > 0 && regularMax > 0) {
    return {
      readyMin: regularMin,
      readyMax: regularMax,
      overallMinStart,
      overallMaxEnd
    };
  }

  return {
    readyMin: 5,
    readyMax: 6,
    overallMinStart,
    overallMaxEnd
  };
}

function parseShippingDaysFromText(text) {
  if (!text) return null;

  const t = text.toLowerCase();

  const range = t.match(
    /(\d+)\s*(?:-|–|—|to)\s*(\d+)/
  );

  if (range) {
    return {
      min: Number(range[1]),
      max: Number(range[2]),
      match: range[0]
    };
  }

  const plus = t.match(/(\d+)\s*\+/);

  if (plus) {
    const min = Number(plus[1]);

    return {
      min,
      max: min + 2,
      match: plus[0]
    };
  }

  const single = t.match(/(\d+)\s*day/);

  if (single) {
    const n = Number(single[1]);

    return {
      min: n,
      max: n,
      match: single[0]
    };
  }

  return null;
}

function compileTemplates(templates) {
  const compiled = [];

  for (const template of templates) {
    const regex = buildTemplateRegex(template);
    if (regex) compiled.push(regex);
  }

  return compiled;
}

function parseDaysFromTemplates(title, compiledTemplates) {
  for (const regex of compiledTemplates) {
    const match = title.match(regex);

    if (!match) continue;

    const parsedWindow = parseShippingDaysFromText(match[1]);
    if (!parsedWindow) continue;

    return { ...parsedWindow, match: match[0] };
  }

  return null;
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTemplateRegex(template) {
  if (typeof template !== "string" || !template.includes("{window}")) {
    return null;
  }

  const source = template
    .split("{window}")
    .map(escapeRegex)
    .join("(\\d+(?:\\s*(?:-|–|—|to)\\s*\\d+|\\+)?)");

  return new RegExp(source, "i");
}

function getKeywordDefaultDays(title) {
  const t = title.toLowerCase();

  const map = {
    overnight: { min: 1, max: 1 },
    express: { min: 1, max: 2 },
    priority: { min: 2, max: 4 },
    standard: { min: 3, max: 7 },
    economy: { min: 5, max: 10 }
  };

  for (const key in map) {
    if (t.includes(key)) {
      return map[key];
    }
  }

  return null;
}

function buildUpdatedTitle(
  title,
  matchedText,
  format,
  label
) {
  const replacement =
    format.replace("{label}", label);

  if (!matchedText) {
    return `${replacement} ${title}`;
  }

  return replaceFirstIgnoreCase(title, matchedText)
    .replace(/\s+/g, " ")
    .trim() +
    ` ${replacement}`;
}

function replaceFirstIgnoreCase(source, search) {
  const haystack = String(source);
  const needle = String(search || "");
  if (!needle) return haystack;

  const index = haystack.toLowerCase().indexOf(needle.toLowerCase());
  if (index === -1) return haystack;

  return haystack.slice(0, index) + haystack.slice(index + needle.length);
}