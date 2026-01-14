// @ts-nocheck

/*
  This runtime intentionally avoids strict TS checking because the
  generated types may not be present during local editing. Keep this
  file permissive and use `shopify app function typegen` to generate
  accurate types in `generated/api` when ready.
*/

/**
 * Generic placeholder for no-op result
 */
const NO_CHANGES = {
  operations: [],
};

/** @param {any} input */
/** @returns {any} */
export function cartDeliveryOptionsTransformRun(input) {

  // No shop-level configuration here — Function inputs may omit large shop metafields.

  let now = input?.shop?.localTime?.date ? new Date(input.shop.localTime.date) : new Date();
  // Start counting from tomorrow
  now.setDate(now.getDate() + 1);

  // parse small admin-provided templates metafield (namespace: distacart, key: delivery_templates)
  const shopTemplatesRaw = input?.shop?.metafield?.jsonValue ?? input?.shop?.metafield?.value;
  let shopTemplates = null;
  try { shopTemplates = typeof shopTemplatesRaw === 'string' ? JSON.parse(shopTemplatesRaw) : shopTemplatesRaw; } catch (e) { shopTemplates = null; }
  const templates = Array.isArray(shopTemplates?.templates) ? shopTemplates.templates : [];
  const replacementFormat = (shopTemplates && shopTemplates.replacementFormat) || 'Estimated Delivery: {label}';
  const countries = Array.isArray(shopTemplates?.countries)
    ? shopTemplates.countries.map((c) => String(c).toUpperCase().trim()).filter(Boolean)
    : [];

  // safe pattern to match numeric windows inside admin templates (captures the window)
  const WINDOW_PATTERN = '(\\d{1,2}(?:\\s*(?:[-–—]|to)\\s*\\d{1,2})?|\\d{1,2}\\+)';
  function escapeRegexLiteral(s) { return s.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'); }
  function buildTemplateRegex(template) {
    if (!template || !template.includes('{window}')) return null;
    const parts = template.split('{window}').map(escapeRegexLiteral);
    const source = parts.join(WINDOW_PATTERN);
    try { return new RegExp(source, 'i'); } catch (e) { return null; }
  }

  // small helpers
  function toNumberSafe(v) {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const t = v.trim();
      if (t === '' || t.toLowerCase() === 'none') return 0;
      const n = Number(t.replace(/,/g, ''));
      return Number.isNaN(n) ? 0 : n;
    }
    return 0;
  }

  function addBusinessDays(start, days) {
    const d = new Date(start);
    let added = 0;
    while (added < days) {
      d.setDate(d.getDate() + 1);
      const day = d.getDay();
      if (day !== 0 && day !== 6) added++;
    }
    return d;
  }

  function formatDateShort(date) {
    try {
      const d = new Date(date);
      // format as '11 Nov' (day then short month) to match requested display
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${d.getDate()} ${months[d.getMonth()]}`;
    } catch (e) {
      return new Date(date).toISOString().slice(0,10);
    }
  }

  function parseVariantReadyValue(rawVal) {
    if (rawVal === null || rawVal === undefined) return null;
    let parsed = rawVal;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch (e) { /* keep string */ }
    }

    // object shape with min/max keys or date keys
    if (parsed && typeof parsed === 'object') {
      const vr = {};
      if (parsed.min !== undefined) vr.min = toNumberSafe(parsed.min);
      if (parsed.max !== undefined) vr.max = toNumberSafe(parsed.max);
      if (parsed.min_ready_to_ship_days !== undefined) vr.min = toNumberSafe(parsed.min_ready_to_ship_days);
      if (parsed.max_ready_to_ship_days !== undefined) vr.max = toNumberSafe(parsed.max_ready_to_ship_days);
      // absolute date extraction
      const start = parsed.start || parsed.start_date || parsed.min_date || parsed.from || parsed.min_ready_to_ship_date;
      const end = parsed.end || parsed.end_date || parsed.max_date || parsed.to || parsed.max_ready_to_ship_date;
      if (start || end) {
        const s = start ? new Date(start) : null;
        const e = end ? new Date(end) : null;
        return { min: vr.min ?? 0, max: vr.max ?? 0, startISO: s && !isNaN(s) ? s.toISOString() : null, endISO: e && !isNaN(e) ? e.toISOString() : null };
      }
      if (vr.min !== undefined || vr.max !== undefined) return { min: vr.min || 0, max: vr.max || 0 };
    }

    // primitive number or numeric string
    if (typeof parsed === 'number') return { min: parsed, max: parsed };
    if (typeof parsed === 'string' && parsed.trim() !== '') {
      const n = Number(parsed);
      if (!isNaN(n)) return { min: n, max: n };
      // maybe a date string
      const d = new Date(parsed);
      if (!isNaN(d)) return { startISO: d.toISOString(), endISO: d.toISOString() };
    }

    return null;
  }

  // Parse shipping day ranges from free-form title/description text.
  // Examples it should handle:
  //  - "3-5 Business day Priority Shipping (Post Dispatch) > $14.99 (Fedex / DHL)"
  //  - "1 to 3 business days"
  //  - "2+ business days"
  function parseShippingDaysFromText(text) {
    if (!text || typeof text !== 'string') return null;
    const t = text.replace(/[,]/g, ' ').toLowerCase();

    // Range like '3-5 business day' or '3 to 5 business days'
    const rangeMatch = t.match(/(\d{1,2})\s*(?:[-–—]|to)\s*(\d{1,2})\s*(?:business|working)?\s*day/);
    if (rangeMatch) {
      const min = Number(rangeMatch[1]);
      const max = Number(rangeMatch[2]);
      if (!isNaN(min) && !isNaN(max)) return { min, max, match: rangeMatch[0] };
    }

    // Plus style '2+ business day(s)'
    const plusMatch = t.match(/(\d{1,2})\s*\+\s*(?:business|working)?\s*day/);
    if (plusMatch) {
      const min = Number(plusMatch[1]);
      if (!isNaN(min)) return { min, max: min + 2, match: plusMatch[0] };
    }

    // Single number '3 business day' or '3 days'
    const singleMatch = t.match(/(?:about\s*)?(\d{1,2})\s*(?:business|working)?\s*day/);
    if (singleMatch) {
      const n = Number(singleMatch[1]);
      if (!isNaN(n)) return { min: n, max: n, match: singleMatch[0] };
    }

    return null;
  }

  const operations = [];

  // The current GraphQL has `deliveryGroups` and top-level `cart.lines` (not nested per group).
  // We'll read the global lines and apply them to each group (best-effort mapping when lines aren't grouped).
  const groups = input?.cart?.deliveryGroups || [];
  const allLines = input?.cart?.lines || [];
  for (const group of groups) {
    // Dynamic gating: use countries list if provided, else fallback to GB-only
    const countryCode = (group?.deliveryAddress?.countryCode || '').toString().toUpperCase();
    const useDynamic = countries.length > 0;
    const isAllowed = useDynamic ? countries.includes(countryCode) : countryCode === 'GB';
    if (!isAllowed) continue;
    // compute per-line readiness and absolute date ranges using top-level cart.lines
    const perVariant = (allLines || []).map(line => {
      // prefer jsonValue when metafield is typed JSON, otherwise fall back to value
      const raw = line?.merchandise?.metafield?.jsonValue ?? line?.merchandise?.metafield?.value;
      const parsed = parseVariantReadyValue(raw);
      return { id: line.id, quantity: line.quantity || 1, parsed };
    });

    // overall absolute date range if any
    let overallMinStart = null; let overallMaxEnd = null;
    for (const p of perVariant) {
      const dr = p.parsed;
      if (!dr) continue;
      if (dr.startISO) {
        const s = new Date(dr.startISO);
        if (!isNaN(s) && (!overallMinStart || s < overallMinStart)) overallMinStart = s;
      }
      if (dr.endISO) {
        const e = new Date(dr.endISO);
        if (!isNaN(e) && (!overallMaxEnd || e > overallMaxEnd)) overallMaxEnd = e;
      }
    }

    // compute cart-level ready mins/max. Ignore zero/undefined entries when at least one product reports a positive window.
    const numericReady = perVariant.map(p => ({ min: toNumberSafe(p.parsed?.min), max: toNumberSafe(p.parsed?.max) }));
    const positiveMins = numericReady.map(r => r.min).filter(n => n > 0);
    const positiveMaxs = numericReady.map(r => r.max).filter(n => n > 0);
    const cartReadyMin = positiveMins.length > 0 ? Math.min(...positiveMins) : 0;
    const cartReadyMax = positiveMaxs.length > 0 ? Math.max(...positiveMaxs) : 0;

    for (const opt of (group.deliveryOptions || [])) {
  // The shipping window comes from the option title itself (e.g. "3-5 Business day Priority Shipping...")
  const title = (opt.title || '').toString();
  const handle = (opt.handle || '').toString();
  const combinedText = title;

      // Try admin templates first (if provided). If a template matches, extract the numeric window from the capture.
      let parsedDays = null;
      let matchedTemplate = null;
      for (const t of templates) {
        if (typeof t !== 'string') continue;
        if (!t.includes('{window}')) continue;
        if (t.length > 500) continue;
        const re = buildTemplateRegex(t);
        if (!re) continue;
        const m = combinedText.match(re);
        if (m) { matchedTemplate = { template: t, match: m }; break; }
      }
      if (matchedTemplate) {
        // capture group 1 contains the numeric window (e.g. '3-5', '2+', '3')
        const cap = (matchedTemplate.match && matchedTemplate.match[1]) ? matchedTemplate.match[1].toString().trim() : null;
        if (cap) {
          // normalize and parse
          const s = cap.replace(/\s+/g, ' ');
          if (s.includes('+')) {
            const n = Number(s.replace('+',''));
            if (!isNaN(n)) parsedDays = { min: n, max: n + 2, match: matchedTemplate.match[0] };
          } else {
            const rangeMatch = s.match(/(\d{1,2})\s*(?:[-–—]|to)\s*(\d{1,2})/i);
            if (rangeMatch) {
              const min = Number(rangeMatch[1]);
              const max = Number(rangeMatch[2]);
              if (!isNaN(min) && !isNaN(max)) parsedDays = { min, max, match: matchedTemplate.match[0] };
            } else {
              const n = Number(s);
              if (!isNaN(n)) parsedDays = { min: n, max: n, match: matchedTemplate.match[0] };
            }
          }
        }
      }

      // fallback to the old heuristic if templates didn't yield a match
      if (!parsedDays) parsedDays = parseShippingDaysFromText(combinedText);
      let methodMin = 0;
      let methodMax = 0;
      let determined = false;
      if (parsedDays) {
        methodMin = toNumberSafe(parsedDays.min);
        methodMax = toNumberSafe(parsedDays.max);
        determined = true;
      } else {
        // fallback to simple keyword heuristics
        const lower = combinedText.toLowerCase();
        const keywordDefaults = {
          overnight: [1, 1],
          express: [1, 2],
          priority: [2, 4],
          standard: [3, 7],
          economy: [5, 10],
        };
        let found = false;
        for (const k of Object.keys(keywordDefaults)) {
          if (lower.includes(k)) {
            methodMin = keywordDefaults[k][0];
            methodMax = keywordDefaults[k][1];
            found = true;
            break;
          }
        }

        // No country-config mapping available in this runtime (shop metafield omitted). Respect keyword heuristics only.
        if (found) determined = true;
      }

      // If nothing determined the method window, use default 3-5 business days
      if (!determined) {
        methodMin = 3;
        methodMax = 5;
      }

      const deliveryMinDays = cartReadyMin + methodMin;
      const deliveryMaxDays = cartReadyMax + methodMax;

      // compute display dates
      let displayStart = addBusinessDays(now, deliveryMinDays);
      let displayEnd = addBusinessDays(now, deliveryMaxDays);
      if (overallMinStart && overallMaxEnd) {
        displayStart = overallMinStart;
        displayEnd = overallMaxEnd;
      }

      const displayLabel = `${formatDateShort(displayStart)} - ${formatDateShort(displayEnd)}`;

      // Build rename operation (use expected camelCase field names)
      // If an admin template matched, prefer using the admin replacementFormat to compose the new title.
      let newTitle;
      if (matchedTemplate && matchedTemplate.match) {
        const matchedSubstring = matchedTemplate.match[0];
        const titleWithoutNumber = title.replace(new RegExp(matchedSubstring, 'i'), '').replace(/\s+/g, ' ').trim();
        const formattedReplacement = replacementFormat.replace('{label}', displayLabel);
        newTitle = titleWithoutNumber ? `${titleWithoutNumber} ${formattedReplacement}` : `${formattedReplacement} ${title}`;
      } else if (parsedDays && parsedDays.match) {
        // remove the matched numeric phrase from the original title (case-insensitive)
        function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'); }
        const re = new RegExp(escapeRegExp(parsedDays.match), 'i');
        const titleWithoutNumber = title.replace(re, '').replace(/\s+/g, ' ').trim();
        newTitle = `${titleWithoutNumber} ${replacementFormat.replace('{label}', displayLabel)} `;
      } else {
        newTitle = `${replacementFormat.replace('{label}', displayLabel)} ${title || handle}`;
      }
      operations.push({ deliveryOptionRename: { deliveryOptionHandle: opt.handle, title: newTitle } });
    }
  }

  if (!operations.length) return NO_CHANGES;
  return { operations };
};