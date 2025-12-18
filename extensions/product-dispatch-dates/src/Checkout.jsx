import {
  reactExtension,
  Text,
  useCartLineTarget,
  useLocalizationCountry,
  useAppMetafields,
  useDeliveryGroups
} from '@shopify/ui-extensions-react/checkout';

export default reactExtension(
  'purchase.checkout.cart-line-item.render-after',
  () => <Extension />,
);

function Extension() {
  // useCartLineTarget: get the cart line's variant id
  const { merchandise } = useCartLineTarget();
  const variantId = merchandise?.id;
  const deliveryGroups = useDeliveryGroups?.() || [];
  const firstGroup = deliveryGroups[0];
  const selectedHandle = firstGroup?.selectedDeliveryOption?.handle;
  const selectedOption = firstGroup?.deliveryOptions?.find((o) => o.handle === selectedHandle) || null;
  const normalizeKey = (str) => (str ? String(str).trim().toLowerCase() : null);
  const selectedKey = normalizeKey(selectedOption?.code) || normalizeKey(selectedOption?.title);
  

  // Load variant-level metafields and shop-level country data
  const variantMetafields = useAppMetafields({ type: 'variant', namespace: 'distacart', key: 'product_ready_to_ship' });
  const shopMetafields = useAppMetafields({ type: 'shop', namespace: 'distacart', key: 'country_data' });
  const templatesMetafields = useAppMetafields({ type: 'shop', namespace: 'distacart', key: 'delivery_templates' });

  // localization hook (returns country of checkout and re-renders on change)
  const localeCountry = useLocalizationCountry();

  // Only show dispatch dates for UK
  const rawCountry = localeCountry?.isoCode ?? localeCountry?.code ?? localeCountry?.value ?? 'US';
  const countryCode = String(rawCountry).toUpperCase();

  // Dynamic gating via delivery_templates.countries (if provided), else default to GB-only
  const templatesEntry = templatesMetafields && templatesMetafields.length ? templatesMetafields[0] : null;
  let allowedCountries = [];
  try {
    const tv = templatesEntry?.metafield?.value;
    if (tv) {
      const parsed = JSON.parse(tv);
      if (Array.isArray(parsed?.countries)) {
        allowedCountries = parsed.countries.map((c) => String(c).toUpperCase().trim()).filter(Boolean);
      }
    }
  } catch (e) {
    // ignore parse errors
  }
  const useDynamic = allowedCountries.length > 0;
  const shouldShow = useDynamic ? allowedCountries.includes(countryCode) : countryCode === 'GB';
  console.log('[product-dispatch-dates] gating', {
    rawCountry,
    countryCode,
    allowedCountries,
    useDynamic,
    shouldShow,
  });
  if (!shouldShow) return null;

  const variantNumericId = variantId ? variantId.split('/').pop() : null;
  console.log('[product-dispatch-dates] variant context', {
    variantId,
    variantNumericId,
    variantMetafieldsCount: Array.isArray(variantMetafields) ? variantMetafields.length : 0,
  });

  // Find matching variant metafield (handle gid or plain numeric id)
  const variantEntry = variantMetafields.find((entry) => {
    const targetId = entry?.target?.id;
    if (!targetId) return false;
    if (variantId && targetId === variantId) return true;
    if (variantNumericId && (targetId.endsWith(variantNumericId) || targetId.split('/').pop() === variantNumericId)) return true;
    return false;
  });
  if (variantEntry) {
    console.log('[product-dispatch-dates] matched variant entry', {
      targetId: variantEntry?.target?.id,
      hasValue: !!variantEntry?.metafield?.value,
      valuePreview: String(variantEntry?.metafield?.value || '').slice(0, 120),
    });
  } else {
    console.log('[product-dispatch-dates] no variant metafield match');
  }

  // Helper to extract min/max from a parsed object
  const extractMinMax = (obj) => {
    if (!obj) return [null, null];
    const min = obj.min_ready_to_ship_days ?? obj['min delivery days'] ?? obj.min_delivery_days ?? obj.min ?? null;
    const max = obj.max_ready_to_ship_days ?? obj['max delivery days'] ?? obj.max_delivery_days ?? obj.max ?? null;
    return [min ?? null, max ?? null];
  };

  // Try variant metafield first
  if (variantEntry?.metafield?.value) {
    try {
      const parsed = JSON.parse(variantEntry.metafield.value);
      const [vMin, vMax] = extractMinMax(parsed);
      console.log('[product-dispatch-dates] variant parsed', { parsed, vMin, vMax });
      if (vMin != null && vMax != null) {
        console.log('[product-dispatch-dates] returning variant message', { vMin, vMax });
        return <Text>Dispatched between {vMin}-{vMax} business days</Text>;
      }
    } catch (e) {
      console.warn('[product-dispatch-dates] variant metafield parse error', e);
      // fall through to shop default
    }
  }

  // Variant missing or invalid � use shop-level country data as default
  const shopEntry = shopMetafields && shopMetafields.length ? shopMetafields[0] : null;
  console.log('[product-dispatch-dates] shop entry present', { hasShopEntry: !!shopEntry?.metafield?.value });
  if (shopEntry?.metafield?.value) {
    try {
      const parsedShop = JSON.parse(shopEntry.metafield.value);
      console.log('[product-dispatch-dates] parsed shop keys', { keys: Object.keys(parsedShop || {}) });


      const countryObj = parsedShop[countryCode] || parsedShop[countryCode.toUpperCase()];
      console.log('[product-dispatch-dates] countryObj', { present: !!countryObj, keys: countryObj ? Object.keys(countryObj) : null });
      if (countryObj) {
        // Country-level direct min/max
        const [countryMin, countryMax] = extractMinMax(countryObj);
        console.log('[product-dispatch-dates] country-level min/max', { countryMin, countryMax });
        if (countryMin != null && countryMax != null) {
          console.log('[product-dispatch-dates] returning country-level message', { countryMin, countryMax });
          return <Text>Dispatched between {countryMin}-{countryMax} business days</Text>;
        }

        const shippingRates = countryObj['shipping rates'] || countryObj['shipping_rates'] || {};
        const preferred = countryObj['fastest shipping method'] || countryObj['cheapest shipping method'];
        console.log('[product-dispatch-dates] shippingRates', { keys: Object.keys(shippingRates || {}), preferred, selectedKey });

        // Try preferred method first, then any method with usable min/max
        const tryMethodKey = (key) => {
          if (!key) return [null, null];
          const m = shippingRates[key];
          if (!m) return [null, null];
          return extractMinMax(m);
        };

        if (!selectedKey) {
          console.log('[product-dispatch-dates] no selectedKey; cannot map shipping method');
          return null;
        }

        let [sMin, sMax] = tryMethodKey(selectedKey);
        console.log('[product-dispatch-dates] selected method min/max', { sMin, sMax, selectedKey });
        
        if (sMin == null || sMax == null) {
          [sMin, sMax] = tryMethodKey(preferred);
          console.log('[product-dispatch-dates] preferred method fallback min/max', { sMin, sMax, preferred });
        }
        
        if (sMin == null || sMax == null) {
          for (const k of Object.keys(shippingRates)) {
            const [tMin, tMax] = tryMethodKey(k);
            if (tMin != null && tMax != null) {
              sMin = tMin;
              sMax = tMax;
              console.log('[product-dispatch-dates] fallback to any method', { key: k, sMin, sMax });
              break;
            }
          }
        }
        
        if (sMin != null && sMax != null) {
          console.log('[product-dispatch-dates] returning shipping method message', { sMin, sMax });
          return <Text>Dispatched between {sMin}-{sMax} business days</Text>;
        }
        // else continue to fallback
      } else {
        // country entry not found − fall through to generic fallback
        console.warn('[product-dispatch-dates] no country entry for', countryCode);
      }
    } catch (e) {
      console.warn('[product-dispatch-dates] shop country_data parse error', e);
      // fall through to generic fallback
    }
  }

  // Generic fallback
  console.log('[product-dispatch-dates] generic fallback: Dispatch date varies', { countryCode, selectedKey });
  return <Text>Dispatch date varies</Text>;
}