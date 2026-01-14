import { json } from "@remix-run/node";
import prisma from "../db.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Loader: accept GET /api/estimate?shop=shop.myshopify.com&country=US&lineItems=<json>&rates=<json>
export const loader = async ({ request }) => {
  try {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, { status: 405, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const shop = url.searchParams.get("shop");
    const country = (url.searchParams.get("country") || "US").toUpperCase();

    if (!shop || !country) {
      return json({ ok: false, error: "Missing required query params: shop, country" }, { status: 400, headers: CORS_HEADERS });
    }

    // optional JSON-encoded params
    const lineItemsParam = url.searchParams.get("lineItems");
    const ratesParam = url.searchParams.get("rates");
    const variantReadyParam = url.searchParams.get("variantReady");

    let lineItems = [];
    let rates = [];
    let variantReady = {};

    try { if (lineItemsParam) lineItems = JSON.parse(lineItemsParam); } catch (e) { console.warn("Invalid lineItems param", e); }
    try { if (ratesParam) rates = JSON.parse(ratesParam); } catch (e) { console.warn("Invalid rates param", e); }
    try { if (variantReadyParam) variantReady = JSON.parse(variantReadyParam); } catch (e) { console.warn("Invalid variantReady param", e); }

    // Lookup session for shop to get Admin access token
    const session = await prisma.session.findFirst({ where: { shop }, orderBy: { expires: "desc" } });
    if (!session || !session.accessToken) {
      return json({ ok: false, error: "No active session found for shop; install the app or provide ADMIN token as env var." }, { status: 401, headers: CORS_HEADERS });
    }

    const ADMIN_TOKEN = session.accessToken;
    const SHOP_DOMAIN = shop;

    // Fetch shop GID via Admin GraphQL
    async function graphQLAdminFetch({ query, variables }) {
      const url = `https://${SHOP_DOMAIN}/admin/api/2025-07/graphql.json`;
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": ADMIN_TOKEN }, body: JSON.stringify({ query, variables }) });
      if (!res.ok) throw new Error(`Admin GraphQL error ${res.status}`);
      const j = await res.json();
      if (j.errors && j.errors.length) throw new Error(JSON.stringify(j.errors));
      return j.data;
    }

  // We do not need the shop GID for delivery calculations; use SHOP_DOMAIN
  // (the myshopify domain) for any Admin lookups and keep debug smaller.

    // Fetch shop metafield country_data using the shop owner field (some API versions
    // do not expose a root-level `metafield` field on QueryRoot).
    const mfQuery = `query getShopMf($namespace:String!, $key:String!) { shop { metafield(namespace:$namespace, key:$key) { id value type } } }`;
    let countryData = null;
    try {
      const mfData = await graphQLAdminFetch({ query: mfQuery, variables: { namespace: "distacart", key: "country_data" } });
      const mf = mfData && mfData.shop && mfData.shop.metafield;
      if (mf && mf.value) {
        try { countryData = JSON.parse(mf.value); } catch (e) { countryData = mf.value; }
      }
    } catch (e) {
      console.warn("Failed to read shop metafield country_data", e && (e.message || e));
    }

    if (!countryData) countryData = getMockedCountryData();

    // --- small helpers (moved here so they're in-scope for the loader) ---
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
      try { return new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
      catch (e) { return new Date(date).toISOString().slice(0,10); }
    }

    function getMockedCountryData() {
      return {
        US: {
          'country name': 'United States',
          'shipping rates': {
            standard: { 'min delivery days': 15, 'max delivery days': 20 },
            priority: { 'min delivery days': 3, 'max delivery days': 5 },
            express: { 'min delivery days': 5, 'max delivery days': 7 },
          },
          'fastest shipping method': 'priority',
          'cheapest shipping method': 'standard',
        },
      };
    }

    // If variants provided, fetch their product_ready_to_ship metafields
    // But if the extension already supplied `variantReady` in the request, treat those values
    // as authoritative and skip the Admin per-variant fetch to reduce Admin API calls.
    let fetchedVariantReady = {};
  // If metafields contain absolute dates, store them here as { startISO, endISO }
  let fetchedVariantReadyDates = {};
    const variantIds = (lineItems || []).map(li => li?.id).filter(Boolean);
    const variantReadyFromRequest = variantReady || {};
    const hasVariantReadyFromExtension = Object.keys(variantReadyFromRequest).length > 0;

    let nodesRaw = null;
    let variantIdsRequested = [];
    if (variantIds.length && !hasVariantReadyFromExtension) {
      // normalize to GIDs
      const ids = variantIds.map(id => (typeof id === 'string' && id.startsWith('gid://') ? id : `gid://shopify/ProductVariant/${id}`));
      variantIdsRequested = ids.slice();
      const nodesQuery = `query nodes($ids:[ID!]!, $namespace:String!, $key:String!) { nodes(ids:$ids) { __typename ... on ProductVariant { id metafield(namespace:$namespace, key:$key) { value } } } }`;
      try {
        const nodesData = await graphQLAdminFetch({ query: nodesQuery, variables: { ids, namespace: "distacart", key: "product_ready_to_ship" } });
        nodesRaw = nodesData;
        const nodes = nodesData && nodesData.nodes || [];
        // helper: attempt to parse a variety of metafield shapes into a date-range
        function parseDateRangeFromValue(v) {
          if (!v && v !== 0) return null;
          let parsed = v;
          if (typeof v === 'string') {
            try { parsed = JSON.parse(v); } catch (e) { /* keep original string */ }
          }

          // If parsed is an object with obvious date keys
          if (parsed && typeof parsed === 'object') {
            const candidates = {};
            // common keys
            candidates.start = parsed.start || parsed.start_date || parsed.min_date || parsed.earliest || parsed.from || parsed.minStart || parsed.min_start;
            candidates.end = parsed.end || parsed.end_date || parsed.max_date || parsed.latest || parsed.to || parsed.maxEnd || parsed.max_end;
            // alternate keys used in some stores
            candidates.start = candidates.start || parsed.min_ready_to_ship_date || parsed.min_ready_to_ship || parsed.minReadyDate;
            candidates.end = candidates.end || parsed.max_ready_to_ship_date || parsed.max_ready_to_ship || parsed.maxReadyDate;

            // array shaped
            if ((candidates.start === undefined || candidates.end === undefined) && Array.isArray(parsed)) {
              if (parsed.length > 0) candidates.start = parsed[0];
              if (parsed.length > 1) candidates.end = parsed[1];
            }

            // If both present, normalize to ISO strings
            if (candidates.start || candidates.end) {
              try {
                const s = candidates.start ? new Date(candidates.start) : null;
                const e = candidates.end ? new Date(candidates.end) : null;
                if ((s && !isNaN(s)) || (e && !isNaN(e))) {
                  return { startISO: s && !isNaN(s) ? s.toISOString() : null, endISO: e && !isNaN(e) ? e.toISOString() : null };
                }
              } catch (e) { /* fallthrough */ }
            }
          }

          // if parsed is a primitive date string
          if (typeof parsed === 'string') {
            const d = new Date(parsed);
            if (!isNaN(d)) return { startISO: d.toISOString(), endISO: d.toISOString() };
          }

          // if primitive array-like string: "[2025-11-01,2025-11-10]"
          if (typeof v === 'string' && v.trim().startsWith('[')) {
            try {
              const arr = JSON.parse(v);
              if (Array.isArray(arr)) {
                const s = new Date(arr[0]); const e = new Date(arr[1] || arr[0]);
                if (!isNaN(s) || !isNaN(e)) return { startISO: !isNaN(s) ? s.toISOString() : null, endISO: !isNaN(e) ? e.toISOString() : null };
              }
            } catch (e) { /* ignore */ }
          }

          return null;
        }

        for (const n of nodes) {
          if (!n) continue;
          const vid = n.id;
          if (n.metafield && n.metafield.value) {
            const rawVal = n.metafield.value;
            // first try JSON parse to preserve previous behavior
            try {
              const parsed = JSON.parse(rawVal);
              fetchedVariantReady[vid] = parsed;
            } catch (e) {
              const v = rawVal;
              fetchedVariantReady[vid] = !isNaN(Number(v)) ? { min: Number(v), max: Number(v) } : { raw: v };
            }

            // attempt to extract absolute dates if the metafield encodes them
            const dr = parseDateRangeFromValue(rawVal);
            if (dr) {
              fetchedVariantReadyDates[vid] = dr;
              const numeric = vid.split('/').pop(); fetchedVariantReadyDates[numeric] = dr;
            }

            const numeric = vid.split('/').pop(); fetchedVariantReady[numeric] = fetchedVariantReady[vid];
          }
        }
      } catch (e) { console.warn('Failed to fetch variant metafields', e && (e.message || e)); }
    } else if (hasVariantReadyFromExtension) {
      // Use the provided variantReady as fetchedVariantReady shape so merge logic below works uniformly
      for (const [k, v] of Object.entries(variantReadyFromRequest)) {
        fetchedVariantReady[k] = v;
      }
    }

    // merge variantReady from query param with fetched values (fetched takes precedence)
    const perVariantReady = (lineItems || []).map(li => {
      const vid = li?.id || null;
      const vrRequest = variantReady[vid] || {};
      const vrFetchedRaw = fetchedVariantReady[vid] || fetchedVariantReady[(typeof vid === 'string' && vid.startsWith('gid://') ? vid.split('/').pop() : vid)] || {};
      // normalize fetched shape to standard { min, max }
      const vrFetched = {};
      if (vrFetchedRaw) {
        // prefer explicit min/max
        if (vrFetchedRaw.min !== undefined) vrFetched.min = vrFetchedRaw.min;
        if (vrFetchedRaw.max !== undefined) vrFetched.max = vrFetchedRaw.max;
        // alternate keys
        if ((vrFetched.min === undefined || vrFetched.min === null) && vrFetchedRaw.min_ready_to_ship_days !== undefined) vrFetched.min = vrFetchedRaw.min_ready_to_ship_days;
        if ((vrFetched.max === undefined || vrFetched.max === null) && vrFetchedRaw.max_ready_to_ship_days !== undefined) vrFetched.max = vrFetchedRaw.max_ready_to_ship_days;
        if ((vrFetched.min === undefined || vrFetched.min === null) && vrFetchedRaw.minReadyToShipDays !== undefined) vrFetched.min = vrFetchedRaw.minReadyToShipDays;
        if ((vrFetched.max === undefined || vrFetched.max === null) && vrFetchedRaw.maxReadyToShipDays !== undefined) vrFetched.max = vrFetchedRaw.maxReadyToShipDays;
        // numeric raw
        if ((vrFetched.min === undefined || vrFetched.max === undefined) && typeof vrFetchedRaw === 'number') { vrFetched.min = vrFetched.min ?? vrFetchedRaw; vrFetched.max = vrFetched.max ?? vrFetchedRaw; }
        if ((vrFetched.min === undefined || vrFetched.max === undefined) && typeof vrFetchedRaw === 'string' && vrFetchedRaw.trim() !== '') {
          const n = Number(vrFetchedRaw);
          if (!isNaN(n)) { vrFetched.min = vrFetched.min ?? n; vrFetched.max = vrFetched.max ?? n; }
        }
      }
      const vr = Object.assign({}, vrRequest, vrFetched);
      const min = toNumberSafe(vr.min); const max = toNumberSafe(vr.max);
      return { id: vid, quantity: li.quantity || 1, min, max };
    });

    // Also compute per-variant date ranges (if any) and an overall date range across line items
    const perVariantDateRanges = (lineItems || []).map(li => {
      const vid = li?.id || null;
      const dr = fetchedVariantReadyDates[vid] || fetchedVariantReadyDates[(typeof vid === 'string' && vid.startsWith('gid://') ? vid.split('/').pop() : vid)] || null;
      return { id: vid, dateRange: dr };
    });

    // overall min start and max end across provided variant date ranges
    let overallMinStart = null; let overallMaxEnd = null;
    for (const p of perVariantDateRanges) {
      const d = p.dateRange;
      if (!d) continue;
      if (d.startISO) {
        const s = new Date(d.startISO);
        if (!isNaN(s) && (!overallMinStart || s < overallMinStart)) overallMinStart = s;
      }
      if (d.endISO) {
        const e = new Date(d.endISO);
        if (!isNaN(e) && (!overallMaxEnd || e > overallMaxEnd)) overallMaxEnd = e;
      }
    }

  // compute cart-level ready windows: min of all product mins, and max of all product maxes
  const hasAnyProductDays = perVariantReady.some(v => (v.min && v.min > 0) || (v.max && v.max > 0));
  const cartReadyMin = hasAnyProductDays ? Math.min(...perVariantReady.map(v => v.min)) : 0;
  const cartReadyMax = hasAnyProductDays ? Math.max(...perVariantReady.map(v => v.max)) : 0;

    const countryObj = countryData[country] || countryData['US'] || {};
    const shippingRatesMap = (countryObj && countryObj['shipping rates']) || {};
    const candidateKeys = Object.keys(shippingRatesMap || {});

    const rateCandidates = (rates && rates.length) ? rates : [{ title: 'standard' }, { title: 'priority' }];

    const now = new Date();
    const results = rateCandidates.map(rate => {
      const title = (rate.title || rate.name || rate.label || '').toString();
      const serviceName = (rate.service_name || rate.serviceName || '').toString();
      const code = (rate.code || rate.id || '').toString();
      function findMatch(s) { if (!s) return null; const lower = s.toLowerCase(); for (const k of candidateKeys) { if (k.toLowerCase() === lower) return k; if (lower.includes(k.toLowerCase())) return k; } return null; }
      const methodKey = findMatch(serviceName) || findMatch(title) || findMatch(code) || countryObj['fastest shipping method'] || candidateKeys[0];
      const methodObj = shippingRatesMap[methodKey] || {};
      const methodMin = toNumberSafe(methodObj['min delivery days']);
      const methodMax = toNumberSafe(methodObj['max delivery days']);
      const deliveryMinDays = cartReadyMin + methodMin;
      const deliveryMaxDays = cartReadyMax + methodMax;
      // business-day start/end
      // business-day start/end (fallback when we don't have absolute dates)
      const start = addBusinessDays(now, deliveryMinDays);
      const end = addBusinessDays(now, deliveryMaxDays);
      // If variant metafields provided absolute dates, prefer those for display
      let displayStart = start;
      let displayEnd = end;
      let displayFromVariantDates = false;
      if (overallMinStart && overallMaxEnd) {
        displayStart = overallMinStart;
        displayEnd = overallMaxEnd;
        displayFromVariantDates = true;
      }
      // calendar-day (straight add) for comparison/debug
      const calStart = new Date(now);
      calStart.setDate(calStart.getDate() + deliveryMinDays);
      const calEnd = new Date(now);
      calEnd.setDate(calEnd.getDate() + deliveryMaxDays);

      return {
        rateSnapshot: { title, serviceName, code, raw: rate },
        methodKey,
        methodObj,
        delivery: {
          minDays: deliveryMinDays,
          maxDays: deliveryMaxDays,
          // business-day results
          startISO: displayStart ? displayStart.toISOString() : null,
          endISO: displayEnd ? displayEnd.toISOString() : null,
          startLabel: displayStart ? formatDateShort(displayStart) : null,
          endLabel: displayEnd ? formatDateShort(displayEnd) : null,
          // calendar-day comparison
          calendarStartISO: calStart.toISOString(),
          calendarEndISO: calEnd.toISOString(),
          // display uses either variant-provided absolute dates (if present) or the computed business-day range
          display: displayFromVariantDates ? `${formatDateShort(displayStart)} — ${formatDateShort(displayEnd)}` : `${formatDateShort(start)} — ${formatDateShort(end)}`,
          fromVariantDates: displayFromVariantDates,
        }
      };
    });

    // Compact debug payload: only include fields that are needed for troubleshooting
    // or consumed by a client. Omit large raw GraphQL payloads and duplicated data.
    const debug = {
      shopDomain: SHOP_DOMAIN,
      countryParam: country,
      now: now.toISOString(),
      // The list of variant IDs we attempted to read metafields for (if any)
      variantIdsRequested,
      // Per-variant normalized ready windows (min/max in days)
      perVariantReady,
      // If any variants had absolute date ranges, include the overall span
      overallDateRange: overallMinStart && overallMaxEnd ? { startISO: overallMinStart.toISOString(), endISO: overallMaxEnd.toISOString() } : null,
      // Compact rate debug: only method key and the computed delivery block
      rateDebug: results.map(r => ({ methodKey: r.methodKey, delivery: r.delivery }))
    };

    return json({ ok: true, country, cartReady: { min: cartReadyMin, max: cartReadyMax }, results, debug }, { headers: CORS_HEADERS });
  } catch (err) {
    console.error('loader /api/estimate error', err);
    return json({ ok: false, error: String(err) }, { status: 500, headers: CORS_HEADERS });
  }
};