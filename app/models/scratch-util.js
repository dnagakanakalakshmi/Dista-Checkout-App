/** Shared scratch-card helpers with no DB or Shopify imports so they can be unit-tested. */

export function shopFromDest(dest) {
  return String(dest ?? "")
    .replace(/^https?:\/\//, "")
    .replace(/\/admin\/?$/, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

export function shopFromSessionToken(sessionToken = {}) {
  const fromIss = shopFromDest(sessionToken.iss);
  const fromDest = shopFromDest(sessionToken.dest);
  if (fromIss.endsWith(".myshopify.com")) return fromIss;
  if (fromDest.endsWith(".myshopify.com")) return fromDest;
  return fromIss || fromDest;
}

export function idOf(gid) {
  const value = String(gid ?? "").trim();
  if (!value) return "";
  return value.split("/").pop();
}

export function customerIdFromViewer(value) {
  const raw = String(value ?? "").trim();
  if (!raw || /\/(Checkout|Session)\//i.test(raw)) return "";
  if (/\/Customer\//i.test(raw) || /^\d+$/.test(raw)) return idOf(raw);
  return "";
}

export function customerIdLookupValues(value) {
  const customerId = customerIdFromViewer(value);
  return customerId ? [`gid://shopify/Customer/${customerId}`, customerId] : [];
}

export function normalizeOrderId(value) {
  return idOf(value);
}

export function scratchDiscountCodesFromOrder(orderPayload) {
  const rawCodes = [
    ...(Array.isArray(orderPayload?.discount_codes) ? orderPayload.discount_codes : []),
    ...(Array.isArray(orderPayload?.discountCodes) ? orderPayload.discountCodes : []),
  ];
  return rawCodes
    .map((item) => String(typeof item === "string" ? item : item?.code || "").trim().toUpperCase())
    .filter((discountCode) => discountCode.startsWith("SCR-"));
}

export function orderTotalDetailsInShopCurrency(order) {
  const shopMoney =
    order?.total_price_set?.shop_money ??
    order?.current_total_price_set?.shop_money ??
    order?.totalPriceSet?.shopMoney ??
    order?.currentTotalPriceSet?.shopMoney;

  if (
    shopMoney?.amount !== undefined &&
    shopMoney?.amount !== null &&
    String(shopMoney.amount).trim() !== ""
  ) {
    const amount = Number(shopMoney.amount);
    return {
      amount: Number.isFinite(amount) ? amount : null,
      currency: shopMoney.currency_code ?? shopMoney.currencyCode ?? order?.currency ?? null,
      source: "shop_money",
      rawAmount: shopMoney.amount,
    };
  }

  const orderCurrency = String(order?.currency ?? "").toUpperCase();
  const presentmentCurrency = String(order?.presentment_currency ?? "").toUpperCase();
  if (orderCurrency && presentmentCurrency && orderCurrency !== presentmentCurrency) {
    return {
      amount: null,
      currency: orderCurrency,
      source: "missing_shop_money_currency_conversion",
      rawAmount: order?.total_price ?? order?.current_total_price ?? null,
    };
  }

  const rawAmount = order?.total_price ?? order?.current_total_price;
  const amount = Number(rawAmount);
  return {
    amount: Number.isFinite(amount) ? amount : null,
    currency: order?.currency ?? order?.presentment_currency ?? null,
    source: order?.total_price != null ? "total_price" : "current_total_price",
    rawAmount: rawAmount ?? null,
  };
}

export function orderTotalInShopCurrency(order) {
  return orderTotalDetailsInShopCurrency(order).amount;
}

export function hasIssueCap(reward) {
  return Number.isFinite(Number(reward?.maxIssued)) && Number(reward.maxIssued) > 0;
}

export function matchesRewardSegments(reward, customerSegmentIds = []) {
  const rewardSegmentIds = Array.isArray(reward?.segmentIds) ? reward.segmentIds : [];
  const customerSegments =
    customerSegmentIds instanceof Set ? customerSegmentIds : new Set(customerSegmentIds);
  return (
    rewardSegmentIds.length === 0 ||
    rewardSegmentIds.some((segmentId) => customerSegments.has(segmentId))
  );
}

export const EXPIRY_UNITS = ["HOURS", "DAYS", "WEEKS", "MONTHS"];

export function expiryDateFromConfig(config = {}, start = new Date()) {
  const value = Number(config.expiryValue ?? config.expiryHours ?? 48);
  const unit = EXPIRY_UNITS.includes(config.expiryUnit) ? config.expiryUnit : "HOURS";
  const expiresAt = new Date(start);
  if (unit === "MONTHS") {
    const day = expiresAt.getDate();
    expiresAt.setDate(1);
    expiresAt.setMonth(expiresAt.getMonth() + value);
    const lastDay = new Date(expiresAt.getFullYear(), expiresAt.getMonth() + 1, 0).getDate();
    expiresAt.setDate(Math.min(day, lastDay));
  } else {
    const multiplier = { HOURS: 3600000, DAYS: 86400000, WEEKS: 7 * 86400000 }[unit];
    expiresAt.setTime(expiresAt.getTime() + value * multiplier);
  }
  return expiresAt;
}

export function expiryForIssuedCard(card) {
  if (card?.status !== "ISSUED") return null;
  if (card.expiresAt) return card.expiresAt;
  if (!card.issuedAt || !card.rewardTemplate) return null;
  return expiryDateFromConfig(card.rewardTemplate, card.issuedAt);
}

export function resultFor(card) {
  if (!card) return { state: "invalid" };
  const template = card.rewardTemplate;
  const display = {
    label: template?.label,
    category: template?.category || "Other Scratch Cards",
    description: template?.description,
    imageUrl: template?.imageUrl,
    ...(template?.collectionHandle ? { collectionHandle: template.collectionHandle } : {}),
    type: template?.type,
    value: template?.value,
  };
  if (card.status === "ISSUED") {
    const expiresAt = expiryForIssuedCard(card);
    const isExpired = expiresAt && new Date(expiresAt) <= new Date();
    return {
      state: isExpired ? "expired" : "issued",
      ...display,
      ...(expiresAt ? { expiresAt } : {}),
    };
  }
  if (card.status === "REDEEMED") {
    return {
      state: "redeemed",
      ...display,
      code: card.discountCode,
      expiresAt: card.expiresAt,
      redeemedAt: card.redeemedAt,
    };
  }
  const expiresAt = card.expiresAt ? new Date(card.expiresAt) : null;
  if (card.status === "EXPIRED" || (expiresAt && expiresAt < new Date())) {
    return {
      state: "expired",
      ...display,
      code: card.discountCode,
      expiresAt: card.expiresAt,
    };
  }
  if (card.status === "VOID") return { state: "void", ...display };
  if (
    card.status === "REVEALED" &&
    !card.discountCode &&
    !["WALLET", "POINTS"].includes(template?.type)
  ) {
    return { state: "processing", ...display };
  }
  return {
    state: "revealed",
    ...display,
    code: card.discountCode,
    expiresAt: card.expiresAt,
  };
}

export function storefrontScratchUrl(shop, token) {
  return `https://${shopFromDest(shop)}/apps/scratch/${token}`;
}

export function orderPayloadFromAdmin(order) {
  const orderId = idOf(order?.id);
  const customerGid = order?.customer?.id || null;
  const shopMoney = order?.currentTotalPriceSet?.shopMoney;
  return {
    id: orderId,
    name: order?.name || orderId,
    total_price: Number(shopMoney?.amount ?? 0),
    total_price_set: {
      shop_money: {
        amount: shopMoney?.amount,
        currency_code: shopMoney?.currencyCode,
      },
    },
    currency: order?.currencyCode ?? null,
    presentment_currency: order?.presentmentCurrencyCode ?? null,
    customer: customerGid
      ? { id: idOf(customerGid), admin_graphql_api_id: customerGid }
      : null,
    test: Boolean(order?.test),
  };
}
