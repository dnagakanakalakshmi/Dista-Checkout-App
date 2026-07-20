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

  const templates = Array.isArray(shopConfig.templates)
    ? shopConfig.templates
    : [];

  const replacementFormat =
    shopConfig.replacementFormat ||
    "Estimated Delivery: {label}";

  const countries = Array.isArray(shopConfig.countries)
    ? shopConfig.countries.map(c => String(c).toUpperCase().trim())
    : [];

  const allowAllCountries = countries.includes("ALL");

  const groups = input?.cart?.deliveryGroups || [];
  const allLines = input?.cart?.lines || [];
  const operations = [];

  for (const group of groups) {
    const countryCode = String(
      group?.deliveryAddress?.countryCode || ""
    ).toUpperCase();

    const isAllowed =
      countries.length > 0
        ? allowAllCountries || countries.includes(countryCode)
        : countryCode === "GB";

    if (!isAllowed) continue;

    const lineData = getLineDeliveryData(
      allLines,
      countryCode
    );

    const {
      readyMin,
      readyMax,
      overallMinStart,
      overallMaxEnd
    } = getReadyDays(input, lineData);

    for (const option of group.deliveryOptions || []) {
      const title = String(option.title || "");
      const parsedDays =
        parseDaysFromTemplates(title, templates) ||
        parseShippingDaysFromText(title) ||
        getKeywordDefaultDays(title) || {
          min: 3,
          max: 5
        };

      const deliveryMinDays =
        readyMin + parsedDays.min;

      const deliveryMaxDays =
        readyMax + parsedDays.max;

      let displayStart = addBusinessDays(
        now,
        deliveryMinDays
      );

      let displayEnd = addBusinessDays(
        now,
        deliveryMaxDays
      );

      if (overallMinStart && overallMaxEnd) {
        displayStart = overallMinStart;
        displayEnd = overallMaxEnd;
      }

      const displayLabel =
        `${formatDateShort(displayStart)} - ${formatDateShort(displayEnd)}`;

      const newTitle = buildUpdatedTitle(
        title,
        parsedDays.match,
        replacementFormat,
        displayLabel
      );

      operations.push({
        deliveryOptionRename: {
          deliveryOptionHandle: option.handle,
          title: newTitle
        }
      });
    }
  }

  return operations.length
    ? { operations }
    : NO_CHANGES;
}

/* ---------------- HELPERS ---------------- */

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

function addBusinessDays(start, days) {
  const d = new Date(start);
  let added = 0;

  while (added < days) {
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

function getLineDeliveryData(lines, countryCode) {
  return lines.map(line => {
    const parsed = parseVariantReadyValue(
      line?.merchandise?.metafield?.jsonValue ??
      line?.merchandise?.metafield?.value
    );

    const rapidEligible =
      parseRapidDeliveryEligible(
        line?.merchandise?.rapidDeliveryEligible?.jsonValue ??
        line?.merchandise?.rapidDeliveryEligible?.value,
        countryCode
      );

    return {
      parsed:
        countryCode === "US" && rapidEligible
          ? { ...(parsed || {}), min: 1, max: 1 }
          : parsed
    };
  });
}

function getReadyDays(input, lineData) {
  let anyMissing = false;
  let highestMax = 0;
  let correspondingMin = 0;
  let overallMinStart = null;
  let overallMaxEnd = null;

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

  let fallbackMin = 0;
  let fallbackMax = 0;

  if (anyMissing) {
    fallbackMin = 5;
    fallbackMax = 6;
  }

  return {
    readyMin: Math.max(
      correspondingMin,
      fallbackMin
    ),
    readyMax: Math.max(
      highestMax,
      fallbackMax
    ),
    overallMinStart,
    overallMaxEnd
  };
}

function parseShippingDaysFromText(text) {
  if (!text) return null;

  const t = text.toLowerCase();

  const range =
    t.match(/(\d+)\s*(?:-|to)\s*(\d+)/);

  if (range) {
    return {
      min: Number(range[1]),
      max: Number(range[2]),
      match: range[0]
    };
  }

  const plus = t.match(/(\d+)\+/);

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

function parseDaysFromTemplates(title, templates) {
  for (const template of templates) {
    const regex = buildTemplateRegex(template);

    if (!regex) continue;

    const match = title.match(regex);

    if (!match) continue;

    // return parseShippingDaysFromText(match[1]);

    const parsedWindow = parseShippingDaysFromText(match[1]);
    if (!parsedWindow) continue;

    return { ...parsedWindow, match: match[0] }; // full "6-9 Business day", not just "6-9"
    
  }

  return null;
}

function buildTemplateRegex(template) {
  if (!template?.includes("{window}")) {
    return null;
  }

  const source = template.replace(
    "{window}",
    "(\\d+(?:\\s*(?:-|–|—|to)\\s*\\d+|\\+)?)"
  );

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

  return title
    .replace(new RegExp(matchedText, "i"), "")
    .replace(/\s+/g, " ")
    .trim() +
    ` ${replacement}`;
}