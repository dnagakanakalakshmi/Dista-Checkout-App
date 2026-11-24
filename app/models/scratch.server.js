import crypto from "node:crypto";
import db from "../db.server.js";
import { unauthenticated } from "../shopify.server.js";
import { eligibleRewards, pickReward } from "./pick-reward.js";
import { signToken, verifyToken } from "./scratch-token.js";
import { DEFAULT_SCRATCH_REWARDS, defaultRewardId } from "./scratch-defaults.js";
import {
  expiryDateFromConfig,
  expiryForIssuedCard,
  hasIssueCap,
  customerIdFromViewer,
  customerIdLookupValues,
  idOf,
  matchesRewardSegments,
  normalizeOrderId,
  orderTotalDetailsInShopCurrency,
  orderPayloadFromAdmin,
  resultFor,
  scratchDiscountCodesFromOrder,
  shopFromDest,
} from "./scratch-util.js";

export { signToken, verifyToken } from "./scratch-token.js";
export { resultFor } from "./scratch-util.js";

const isUniqueError = (error) => error?.code === "P2002";

async function ensureIssuedExpiry(card) {
  if (card?.status !== "ISSUED" || card.expiresAt) return card;
  const expiresAt = expiryForIssuedCard(card);
  if (!expiresAt) return card;
  await db.scratchCard.updateMany({
    where: { id: card.id, status: "ISSUED", expiresAt: null },
    data: { expiresAt },
  });
  return { ...card, expiresAt };
}

function debugScratch(message, details) {
  if (process.env.SCRATCH_DEBUG === "true") console.info(message, details);
}

function orderFields(order) {
  const customerId =
    order.customer?.admin_graphql_api_id ||
    (order.customer?.id ? `gid://shopify/Customer/${order.customer.id}` : null);
  const totalDetails = orderTotalDetailsInShopCurrency(order);
  return {
    orderId: normalizeOrderId(order.id),
    orderName: order.name || order.order_number?.toString(),
    customerId,
    total: totalDetails.amount,
    totalCurrency: totalDetails.currency,
    totalSource: totalDetails.source,
    rawTotal: totalDetails.rawAmount,
  };
}

export async function ensureScratchSetup(shop, createDefaults = true) {
  await db.scratchConfig.upsert({
    where: { shop },
    update: {},
    create: { shop },
  });
  if (!createDefaults) return;
  const existing = await db.rewardTemplate.count({ where: { shop } });
  if (existing > 0) return;
  for (const reward of DEFAULT_SCRATCH_REWARDS) {
    try {
      await db.rewardTemplate.create({
        data: {
          id: defaultRewardId(shop, reward.label),
          shop,
          ...reward,
          active: true,
        },
      });
    } catch (error) {
      if (!isUniqueError(error)) throw error;
    }
  }
}

export async function findCardForOrder(shop, orderId) {
  const normalizedId = normalizeOrderId(orderId);
  if (!shop || !normalizedId) return null;
  return db.scratchCard.findUnique({
    where: { shop_orderId: { shop, orderId: normalizedId } },
    include: { rewardTemplate: true },
  });
}

async function issueCardForOrderInternal(shop, orderPayload) {
  if (!orderPayload || typeof orderPayload !== "object" || Array.isArray(orderPayload)) {
    throw new TypeError("Scratch card issuance requires an order payload.");
  }
  const skipTestOrder =
    process.env.SCRATCH_SKIP_TEST_ORDERS === "true" && orderPayload?.test;
  debugScratch("[scratch] issue start", {
    shop,
    orderId: orderPayload?.id,
    testOrder: Boolean(orderPayload?.test),
    skipTestOrder: Boolean(skipTestOrder),
  });

  if (skipTestOrder) {
    debugScratch("[scratch] skip: test order", { shop, orderId: orderPayload?.id });
    return null;
  }

  const order = orderFields(orderPayload || {});
  if (!order.orderId) {
    debugScratch("[scratch] skip: missing order id");
    return null;
  }
  if (order.total === null) {
    console.warn("[scratch] skip: unable to determine order total in shop currency", {
      shop,
      orderId: order.orderId,
      rawTotal: order.rawTotal,
      totalCurrency: order.totalCurrency,
      totalSource: order.totalSource,
      orderCurrency: orderPayload.currency,
      presentmentCurrency: orderPayload.presentment_currency,
    });
    return null;
  }

  const existing = await db.scratchCard.findUnique({
    where: { shop_orderId: { shop, orderId: order.orderId } },
  });
  if (existing) {
    debugScratch("[scratch] card already exists", {
      shop,
      orderId: order.orderId,
      cardId: existing.id,
      status: existing.status,
      rewardTemplateId: existing.rewardTemplateId,
    });
    return existing;
  }

  await ensureScratchSetup(shop, false);

  const activeRewards = await db.rewardTemplate.findMany({ where: { shop, active: true } });
  const rewardEvaluations =
    process.env.SCRATCH_DEBUG === "true"
      ? activeRewards.map((reward) => ({
          id: reward.id,
          label: reward.label,
          weight: reward.weight,
          minOrderValue: reward.minOrderValue,
          orderMeetsMinimum: order.total >= Number(reward.minOrderValue),
          hasPositiveWeight: Number(reward.weight) > 0,
          maxIssued: reward.maxIssued,
          issuedCount: reward.issuedCount,
          issueCapReached:
            hasIssueCap(reward) && Number(reward.issuedCount) >= Number(reward.maxIssued),
          segmentIds: reward.segmentIds || [],
        }))
      : undefined;
  debugScratch(
    "[scratch] order reward eligibility input",
    rewardEvaluations
      ? {
          shop,
          orderId: order.orderId,
          orderTotal: order.total,
          orderCurrency: order.totalCurrency,
          totalSource: order.totalSource,
          rawTotal: order.rawTotal,
          hasCustomer: Boolean(order.customerId),
          activeRewardCount: activeRewards.length,
          rewards: rewardEvaluations,
        }
      : { shop, orderId: order.orderId, activeRewardCount: activeRewards.length },
  );
  let candidates = eligibleRewards(activeRewards, order.total);
  if (!candidates.length) {
    debugScratch("[scratch] skip: no reward passes amount, weight, and issue-cap checks", {
      shop,
      orderId: order.orderId,
      orderTotal: order.total,
      orderCurrency: order.totalCurrency,
      rewards: rewardEvaluations,
    });
    return null;
  }

  const configuredSegments = [...new Set(candidates.flatMap((reward) => reward.segmentIds || []))];
  if (configuredSegments.length) {
    const customerSegmentIds = new Set();
    if (order.customerId) {
      const { admin } = await unauthenticated.admin(shop);
      const response = await admin.graphql(
        `#graphql
        query ScratchCustomerSegmentMembership($customerId: ID!, $segmentIds: [ID!]!) {
          customerSegmentMembership(customerId: $customerId, segmentIds: $segmentIds) {
            memberships {
              segmentId
              isMember
            }
          }
        }`,
        {
          variables: {
            customerId: order.customerId,
            segmentIds: configuredSegments,
          },
        },
      );
      const payload = await response.json();
      if (payload.errors?.length) {
        console.error("[scratch] customer segment membership lookup failed", {
          shop,
          segmentIds: configuredSegments,
          errors: payload.errors,
        });
        throw new Error("Unable to check customer segment eligibility.");
      }
      const memberships = payload.data?.customerSegmentMembership?.memberships;
      const requestedSegmentIds = new Set(configuredSegments);
      const returnedSegmentIds = Array.isArray(memberships)
        ? new Set(memberships.map((membership) => membership?.segmentId))
        : new Set();
      if (
        !Array.isArray(memberships) ||
        memberships.length !== configuredSegments.length ||
        returnedSegmentIds.size !== configuredSegments.length ||
        configuredSegments.some((segmentId) => !returnedSegmentIds.has(segmentId)) ||
        memberships.some((membership) => !requestedSegmentIds.has(membership?.segmentId))
      ) {
        console.error("[scratch] customer segment membership lookup returned incomplete results", {
          shop,
          segmentIds: configuredSegments,
          memberships,
        });
        throw new Error("Unable to check customer segment eligibility.");
      }
      const membershipResults = memberships.map(({ segmentId, isMember }) => ({
        segmentId,
        matched: isMember,
      }));
      for (const result of membershipResults) {
        if (result.matched) customerSegmentIds.add(result.segmentId);
      }
      debugScratch("[scratch] customer segment eligibility results", {
        shop,
        orderId: order.orderId,
        results: membershipResults,
      });
    } else {
      debugScratch("[scratch] segment eligibility skipped: order has no customer", {
        shop,
        orderId: order.orderId,
        requiredSegmentIds: configuredSegments,
      });
    }
    const beforeSegmentCheck = candidates;
    candidates = candidates.filter((reward) =>
      matchesRewardSegments(reward, customerSegmentIds),
    );
    debugScratch("[scratch] reward segment eligibility results", {
      shop,
      orderId: order.orderId,
      matchedSegmentIds: [...customerSegmentIds],
      rewards: beforeSegmentCheck.map((reward) => ({
        id: reward.id,
        label: reward.label,
        requiredSegmentIds: reward.segmentIds || [],
        matched: candidates.some((candidate) => candidate.id === reward.id),
      })),
    });
  }
  if (!candidates.length) {
    debugScratch("[scratch] skip: customer does not match eligible reward segments", {
      shop,
      orderId: order.orderId,
      orderTotal: order.total,
      orderCurrency: order.totalCurrency,
    });
    return null;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reward = pickReward(candidates, order.total);
    if (!reward) {
      debugScratch("[scratch] skip: reward selection returned no eligible reward", {
        shop,
        orderId: order.orderId,
        orderTotal: order.total,
        orderCurrency: order.totalCurrency,
        candidates: candidates.map(({ id, label, weight, minOrderValue, maxIssued, issuedCount }) => ({
          id,
          label,
          weight,
          minOrderValue,
          maxIssued,
          issuedCount,
        })),
      });
      return null;
    }
    debugScratch("[scratch] reward selected", {
      shop,
      orderId: order.orderId,
      attempt: attempt + 1,
      rewardId: reward.id,
      rewardLabel: reward.label,
      weight: reward.weight,
      minOrderValue: reward.minOrderValue,
      eligibleRewardCount: candidates.length,
    });
    let reserved = false;
    if (hasIssueCap(reward)) {
      const result = await db.rewardTemplate.updateMany({
        where: { id: reward.id, issuedCount: { lt: reward.maxIssued } },
        data: { issuedCount: { increment: 1 } },
      });
      if (!result.count) {
        console.warn("[scratch] selected reward issue cap reached during reservation", {
          shop,
          orderId: order.orderId,
          rewardId: reward.id,
          rewardLabel: reward.label,
          maxIssued: reward.maxIssued,
          issuedCount: reward.issuedCount,
        });
        const index = candidates.findIndex((item) => item.id === reward.id);
        if (index >= 0) candidates.splice(index, 1);
        continue;
      }
      reserved = true;
    }
    try {
      const {
        total: _total,
        totalCurrency: _totalCurrency,
        totalSource: _totalSource,
        rawTotal: _rawTotal,
        ...orderData
      } = order;
      const issuedAt = new Date();
      const created = await db.scratchCard.create({
        data: {
          shop,
          ...orderData,
          issuedAt,
          expiresAt: expiryDateFromConfig(reward, issuedAt),
          rewardTemplateId: reward.id,
        },
        include: { rewardTemplate: true },
      });
      debugScratch("[scratch] card created", {
        shop,
        orderId: order.orderId,
        rewardId: reward.id,
        rewardLabel: reward.label,
      });
      return created;
    } catch (error) {
      if (reserved) {
        await db.rewardTemplate.update({
          where: { id: reward.id },
          data: { issuedCount: { decrement: 1 } },
        });
      }
      if (isUniqueError(error)) {
        return db.scratchCard.findUnique({
          where: { shop_orderId: { shop, orderId: order.orderId } },
          include: { rewardTemplate: true },
        });
      }
      console.error("[scratch] card creation failed", {
        shop,
        orderId: order.orderId,
        rewardId: reward.id,
        error,
      });
      throw error;
    }
  }
  return null;
}

export async function issueCardForOrder(shop, orderPayload) {
  const startedAt = Date.now();
  try {
    return await issueCardForOrderInternal(shop, orderPayload);
  } finally {
    debugScratch("[scratch] issuance duration", {
      shop,
      orderId: orderPayload?.id,
      durationMs: Date.now() - startedAt,
    });
  }
}

async function fetchAdminOrder(shop, orderId) {
  const startedAt = Date.now();
  const gid = String(orderId).startsWith("gid://")
    ? orderId
    : `gid://shopify/Order/${normalizeOrderId(orderId)}`;
  try {
    const { admin } = await unauthenticated.admin(shop);
    const response = await admin.graphql(
      `#graphql
      query ScratchOrder($id: ID!) {
        order(id: $id) {
          id
          name
          createdAt
          cancelledAt
          test
          fullyPaid
          displayFinancialStatus
          currencyCode
          presentmentCurrencyCode
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          customer { id }
        }
      }`,
      { variables: { id: gid } },
    );
    const json = await response.json();
    if (json.errors?.length) {
      console.error("[scratch] admin order query failed", json.errors);
      throw new Error("Unable to load order details from Shopify.");
    }
    return json.data?.order || null;
  } finally {
    debugScratch("[scratch] lazy Shopify order query duration", {
      shop,
      orderId,
      durationMs: Date.now() - startedAt,
    });
  }
}

export async function issueCardFromAdminOrder(shop, orderId, viewerSub) {
  const order = await fetchAdminOrder(shop, orderId);
  if (!order || order.cancelledAt || !order.fullyPaid) {
    debugScratch("[scratch] skip lazy issue: missing, cancelled, or unpaid order", {
      shop,
      orderId,
      found: Boolean(order),
      cancelled: Boolean(order?.cancelledAt),
      fullyPaid: Boolean(order?.fullyPaid),
      financialStatus: order?.displayFinancialStatus,
    });
    return null;
  }
  const viewer = customerIdFromViewer(viewerSub);
  const orderCustomer = idOf(order.customer?.id);
  if (orderCustomer && viewer && orderCustomer !== viewer) {
    debugScratch("[scratch] skip lazy issue: customer mismatch", { shop, orderId });
    return null;
  }
  if (!viewer && order.createdAt && Date.now() - new Date(order.createdAt).getTime() > 30 * 60 * 1000) {
    debugScratch("[scratch] skip lazy issue: guest window expired", { shop, orderId });
    return null;
  }
  return issueCardForOrder(shop, orderPayloadFromAdmin(order));
}

export async function getCardForStorefront({ shop, orderId, viewerSub }) {
  const normalizedId = normalizeOrderId(orderId);
  if (!shop || !normalizedId) return null;

  let card = await findCardForOrder(shop, normalizedId);
  if (!card) {
    try {
      card = await issueCardFromAdminOrder(shop, normalizedId, viewerSub);
    } catch (error) {
      console.error("[scratch] lazy issue failed", error);
      throw error;
    }
  }
  if (!card || card.status === "VOID") return null;

  const viewer = customerIdFromViewer(viewerSub);
  if (card.customerId && viewer && idOf(card.customerId) !== viewer) return null;
  if (!viewer && Date.now() - new Date(card.issuedAt).getTime() > 30 * 60 * 1000) {
    return null;
  }
  card = await ensureIssuedExpiry(card);
  if (
    ["ISSUED", "REVEALED"].includes(card.status)
    && card.expiresAt
    && card.expiresAt <= new Date()
  ) {
    const [reconciledCard] = await reconcileExpiredScratchCards(shop, [card]);
    card =
      reconciledCard ||
      (await db.scratchCard.findUnique({
        where: { id: card.id },
        include: { rewardTemplate: true },
      }));
  }
  return card;
}

export async function voidCardForOrder(shop, orderId) {
  const card = await findCardForOrder(shop, orderId);
  if (!card || card.status === "VOID") return card;
  if (card.status === "REVEALED" && card.discountId) {
    try {
      const { admin } = await unauthenticated.admin(shop);
      const response = await admin.graphql(
        `mutation Deactivate($id: ID!) { discountCodeDeactivate(id: $id) { userErrors { message } } }`,
        { variables: { id: card.discountId } },
      );
      const payload = await response.json();
      const errors = [
        ...(payload.errors || []),
        ...(payload.data?.discountCodeDeactivate?.userErrors || []),
      ];
      if (!payload.data?.discountCodeDeactivate && !payload.errors?.length) {
        throw new Error("Shopify returned no result while deactivating the discount.");
      }
      if (errors.length) {
        throw new Error(errors.map((error) => error.message).join("; "));
      }
    } catch (error) {
      console.error("[scratch] discount deactivate failed", error);
      throw error;
    }
  }
  return db.scratchCard.update({ where: { id: card.id }, data: { status: "VOID" } });
}

export async function markScratchCardRedeemed(shop, orderPayload) {
  const discountCodes = scratchDiscountCodesFromOrder(orderPayload);
  const normalizedShop = shopFromDest(shop);
  debugScratch("[scratch] redemption webhook received", {
    shop: normalizedShop,
    orderId: orderPayload?.id,
    discountCodeCount: discountCodes.length,
  });
  if (!normalizedShop || !discountCodes.length) return null;
  const card = await db.scratchCard.findFirst({
    where: {
      shop: normalizedShop,
      discountCode: { in: discountCodes },
      status: "REVEALED",
    },
  });
  if (!card) return null;
  const redeemedAt = new Date();
  const updated = await db.scratchCard.updateMany({
    where: { id: card.id, status: "REVEALED" },
    data: { status: "REDEEMED", redeemedAt },
  });
  if (!updated.count) return null;
  if (card.discountId) {
    try {
      const { admin } = await unauthenticated.admin(normalizedShop);
      const response = await admin.graphql(
        `mutation Deactivate($id: ID!) { discountCodeDeactivate(id: $id) { userErrors { message } } }`,
        { variables: { id: card.discountId } },
      );
      const payload = await response.json();
      const errors = payload.data?.discountCodeDeactivate?.userErrors || [];
      if (errors.length) console.error("[scratch] redeemed discount deactivation failed", errors);
    } catch (error) {
      console.error("[scratch] redeemed discount deactivation failed", error);
    }
  }
  debugScratch("[scratch] reward marked redeemed", {
    shop: normalizedShop,
    orderId: orderPayload?.id,
    cardId: card.id,
  });
  return db.scratchCard.findUnique({ where: { id: card.id }, include: { rewardTemplate: true } });
}

function code() {
  return `SCR-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

export async function reconcileExpiredScratchCards(shop, existingCards) {
  const now = new Date();
  const cards =
    existingCards ||
    (await db.scratchCard.findMany({
      where: {
        shop,
        status: { in: ["ISSUED", "REVEALED"] },
        expiresAt: { lte: now },
      },
    }));
  const expiredCards = cards.filter(
    (card) =>
      card.shop === shop &&
      ["ISSUED", "REVEALED"].includes(card.status) &&
      card.expiresAt &&
      card.expiresAt <= now,
  );
  if (!expiredCards.length) return [];

  const expiredIds = expiredCards.map((card) => card.id);
  await db.scratchCard.updateMany({
    where: {
      shop,
      id: { in: expiredIds },
      status: { in: ["ISSUED", "REVEALED"] },
      expiresAt: { lte: now },
    },
    data: { status: "EXPIRED" },
  });

  const reconciledCards = await db.scratchCard.findMany({
    where: { shop, id: { in: expiredIds }, status: "EXPIRED" },
    include: { rewardTemplate: true },
  });
  return reconciledCards;
}

export async function getCustomerScratchRewards(shop, customerId) {
  const customerIds = customerIdLookupValues(customerId);
  if (!shop || !customerIds.length) return [];

  let cards = await db.scratchCard.findMany({
    where: { shop, customerId: { in: customerIds } },
    include: { rewardTemplate: true },
    orderBy: { issuedAt: "desc" },
  });
  cards = await Promise.all(cards.map(ensureIssuedExpiry));
  const expiredCards = await reconcileExpiredScratchCards(shop, cards);
  const expiredIds = new Set(expiredCards.map((card) => card.id));
  cards = cards.map((card) =>
    expiredIds.has(card.id) ? { ...card, status: "EXPIRED" } : card,
  );
  return cards.map((card) => ({
    ...resultFor(card),
    token: signToken(card.id),
    orderName: card.orderName,
    issuedAt: card.issuedAt,
  }));
}

async function createDiscount(shop, card, reward, expiresAt) {
  if (["WALLET", "POINTS"].includes(reward.type)) return { code: null, id: null };
  const { admin } = await unauthenticated.admin(shop);
  const discountCode = code();
  const customerSelection = card.customerId
    ? { customers: { add: [card.customerId] } }
    : { all: true };
  const common = {
    code: discountCode,
    startsAt: new Date().toISOString(),
    endsAt: expiresAt.toISOString(),
    usageLimit: 1,
    appliesOncePerCustomer: true,
    customerSelection,
  };
  const mutation =
    reward.type === "FREE_SHIPPING"
      ? `mutation Create($input: DiscountCodeFreeShippingInput!) { discountCodeFreeShippingCreate(freeShippingCodeDiscount: $input) { codeDiscountNode { id } userErrors { field message } } }`
      : `mutation Create($input: DiscountCodeBasicInput!) { discountCodeBasicCreate(basicCodeDiscount: $input) { codeDiscountNode { id } userErrors { field message } } }`;
  const input =
    reward.type === "FREE_SHIPPING"
      ? { ...common, title: reward.label }
      : {
          ...common,
          title: reward.label,
          customerGets: {
            value:
              reward.type === "PERCENT"
                ? { percentage: reward.value / 100 }
                : { discountAmount: { amount: reward.value, appliesOnEachItem: false } },
            items: { all: true },
          },
        };
  const response = await admin.graphql(mutation, { variables: { input } });
  const data = await response.json();
  const payload = data.data?.discountCodeBasicCreate || data.data?.discountCodeFreeShippingCreate;
  if (data.errors?.length || payload?.userErrors?.length) {
    throw new Error(
      payload?.userErrors?.map((item) => item.message).join(", ") || "Unable to create discount",
    );
  }
  return { code: discountCode, id: payload.codeDiscountNode.id };
}

export async function revealCard(token, viewerSub, expectedShop) {
  const id = verifyToken(token);
  const shop = shopFromDest(expectedShop);
  if (!id || !shop) return { state: "invalid" };
  let card = await db.scratchCard.findUnique({
    where: { id },
    include: { rewardTemplate: true },
  });
  if (!card || card.shop !== shop) return { state: "invalid" };

  const viewer = customerIdFromViewer(viewerSub);
  if (card.customerId && viewer && idOf(card.customerId) !== viewer) {
    return { state: "invalid" };
  }

  if (card.status !== "ISSUED") return resultFor(card);
  card = await ensureIssuedExpiry(card);
  const revealedAt = new Date();
  const expiresAt = card.expiresAt || expiryDateFromConfig(card.rewardTemplate, card.issuedAt);
  if (expiresAt <= revealedAt) {
    await db.scratchCard.updateMany({
      where: { id, status: "ISSUED" },
      data: { status: "EXPIRED", expiresAt },
    });
    return resultFor({ ...card, status: "EXPIRED", expiresAt });
  }
  const claimed = await db.scratchCard.updateMany({
    where: { id, status: "ISSUED" },
    data: { status: "REVEALED", revealedAt, expiresAt },
  });
  if (!claimed.count) {
    card = await db.scratchCard.findUnique({
      where: { id },
      include: { rewardTemplate: true },
    });
    return resultFor(card);
  }
  try {
    const discount = await createDiscount(card.shop, card, card.rewardTemplate, expiresAt);
    card = await db.scratchCard.update({
      where: { id },
      data: { discountCode: discount.code, discountId: discount.id },
      include: { rewardTemplate: true },
    });
    return resultFor(card);
  } catch (error) {
    await db.scratchCard.updateMany({
      where: { id, status: "REVEALED", discountCode: null },
      data: { status: "ISSUED", revealedAt: null },
    });
    throw error;
  }
}
