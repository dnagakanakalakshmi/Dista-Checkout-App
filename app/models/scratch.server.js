import crypto from "node:crypto";
import db from "../db.server.js";
import { unauthenticated } from "../shopify.server.js";
import { pickReward } from "./pick-reward.js";
import { signToken, verifyToken } from "./scratch-token.js";
import { DEFAULT_SCRATCH_REWARDS, defaultRewardId } from "./scratch-defaults.js";
import {
  expiryDateFromConfig,
  hasIssueCap,
  customerIdFromViewer,
  customerIdLookupValues,
  idOf,
  matchesRewardSegments,
  normalizeOrderId,
  orderPayloadFromAdmin,
  resultFor,
  shopFromDest,
} from "./scratch-util.js";

export { signToken, verifyToken } from "./scratch-token.js";
export { resultFor } from "./scratch-util.js";

const isUniqueError = (error) => error?.code === "P2002";

function orderFields(order) {
  const customerId =
    order.customer?.admin_graphql_api_id ||
    (order.customer?.id ? `gid://shopify/Customer/${order.customer.id}` : null);
  return {
    orderId: normalizeOrderId(order.id),
    orderName: order.name || order.order_number?.toString(),
    customerId,
    total: Number(order.total_price ?? order.current_total_price ?? 0),
  };
}

export async function ensureScratchSetup(shop) {
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
  if (!normalizedId) return null;
  const direct = await db.scratchCard.findUnique({
    where: { shop_orderId: { shop, orderId: normalizedId } },
  });
  if (direct) return direct;
  const matches = await db.scratchCard.findMany({ where: { orderId: normalizedId } });
  if (shop) {
    const sameShop = matches.find((card) => card.shop === shop);
    if (sameShop) return sameShop;
  }
  return matches.length === 1 ? matches[0] : null;
}

export async function issueCardForOrder(shop, orderPayload) {
  console.log("[scratch] issue start", shop, orderPayload?.id, "test:", orderPayload?.test);

  if (process.env.SCRATCH_SKIP_TEST_ORDERS === "true" && orderPayload.test) {
    console.log("[scratch] skip: test order");
    return null;
  }

  await ensureScratchSetup(shop);

  const order = orderFields(orderPayload);
  if (!order.orderId) {
    console.log("[scratch] skip: missing order id");
    return null;
  }

  const existing = await db.scratchCard.findUnique({
    where: { shop_orderId: { shop, orderId: order.orderId } },
  });
  if (existing) {
    console.log("[scratch] card already exists", order.orderId);
    return existing;
  }

  let candidates = await db.rewardTemplate.findMany({ where: { shop, active: true } });
  console.log("[scratch] reward templates:", candidates.length);

  const configuredSegments = [...new Set(candidates.flatMap((reward) => reward.segmentIds || []))];
  if (configuredSegments.length) {
    const customerSegmentIds = new Set();
    if (order.customerId) {
      const { admin } = await unauthenticated.admin(shop);
      for (const segmentId of configuredSegments) {
        const response = await admin.graphql(
          `#graphql
          query ScratchCustomerSegmentMember($segmentId: ID!, $query: String!) {
            customerSegmentMembers(first: 1, segmentId: $segmentId, query: $query) {
              edges {
                node {
                  id
                }
              }
            }
          }`,
          {
            variables: {
              segmentId,
              query: `id = ${idOf(order.customerId)}`,
            },
          },
        );
        const payload = await response.json();
        if (payload.errors?.length) {
          console.error("[scratch] customer segment membership lookup failed", {
            shop,
            segmentId,
            errors: payload.errors,
          });
          throw new Error("Unable to check customer segment eligibility.");
        }
        const members = payload.data?.customerSegmentMembers;
        if (!members?.edges) {
          console.error("[scratch] customer segment membership lookup returned no result", {
            shop,
            segmentId,
          });
          throw new Error("Unable to check customer segment eligibility.");
        }
        if (members.edges.length) {
          customerSegmentIds.add(segmentId);
        }
      }
    }
    candidates = candidates.filter((reward) =>
      matchesRewardSegments(reward, customerSegmentIds),
    );
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reward = pickReward(candidates, order.total);
    if (!reward) {
      console.log("[scratch] skip: no eligible reward");
      return null;
    }
    let reserved = false;
    if (hasIssueCap(reward)) {
      const result = await db.rewardTemplate.updateMany({
        where: { id: reward.id, issuedCount: { lt: reward.maxIssued } },
        data: { issuedCount: { increment: 1 } },
      });
      if (!result.count) {
        const index = candidates.findIndex((item) => item.id === reward.id);
        if (index >= 0) candidates.splice(index, 1);
        continue;
      }
      reserved = true;
    }
    try {
      const { total: _total, ...orderData } = order;
      const created = await db.scratchCard.create({
        data: { shop, ...orderData, rewardTemplateId: reward.id },
      });
      console.log("[scratch] card created", order.orderId, reward.label);
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
        });
      }
      throw error;
    }
  }
  return null;
}

async function fetchAdminOrder(shop, orderId) {
  const gid = String(orderId).startsWith("gid://")
    ? orderId
    : `gid://shopify/Order/${normalizeOrderId(orderId)}`;
  const { admin } = await unauthenticated.admin(shop);
  const response = await admin.graphql(
    `#graphql
    query ScratchOrder($id: ID!) {
      order(id: $id) {
        id
        name
        email
        createdAt
        cancelledAt
        test
        fullyPaid
        displayFinancialStatus
        currentTotalPriceSet { shopMoney { amount } }
        customer { id }
      }
    }`,
    { variables: { id: gid } },
  );
  const json = await response.json();
  if (json.errors?.length) {
    console.error("[scratch] admin order query failed", json.errors);
    return null;
  }
  return json.data?.order || null;
}

export async function issueCardFromAdminOrder(shop, orderId, viewerSub) {
  const order = await fetchAdminOrder(shop, orderId);
  if (!order || order.cancelledAt) {
    console.log("[scratch] skip lazy issue: missing or cancelled", orderId);
    return null;
  }
  const viewer = customerIdFromViewer(viewerSub);
  const orderCustomer = idOf(order.customer?.id);
  if (orderCustomer && viewer && orderCustomer !== viewer) {
    console.log("[scratch] skip lazy issue: customer mismatch");
    return null;
  }
  if (!viewer && order.createdAt && Date.now() - new Date(order.createdAt).getTime() > 30 * 60 * 1000) {
    console.log("[scratch] skip lazy issue: guest window expired");
    return null;
  }
  return issueCardForOrder(shop, orderPayloadFromAdmin(order));
}

export async function getCardForStorefront({ shop, orderId, viewerSub }) {
  const normalizedId = normalizeOrderId(orderId);
  if (!shop || !normalizedId) return null;

  await ensureScratchSetup(shop);

  let card = await findCardForOrder(shop, normalizedId);
  if (!card) {
    try {
      card = await issueCardFromAdminOrder(shop, normalizedId, viewerSub);
    } catch (error) {
      console.error("[scratch] lazy issue failed", error);
    }
  }
  if (!card || card.status === "VOID") return null;

  const viewer = customerIdFromViewer(viewerSub);
  if (card.customerId && viewer && idOf(card.customerId) !== viewer) return null;
  if (!card.customerId && Date.now() - new Date(card.issuedAt).getTime() > 30 * 60 * 1000) {
    return null;
  }
  if (card.status === "REVEALED" && card.expiresAt && card.expiresAt <= new Date()) {
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
      await admin.graphql(
        `mutation Deactivate($id: ID!) { discountCodeDeactivate(id: $id) { userErrors { message } } }`,
        { variables: { id: card.discountId } },
      );
    } catch (error) {
      console.error("[scratch] discount deactivate failed", error);
    }

  }
  return db.scratchCard.update({ where: { id: card.id }, data: { status: "VOID" } });
}

export async function markScratchCardRedeemed(shop, orderPayload) {
  const rawDiscountCodes = [
    ...(Array.isArray(orderPayload?.discount_codes) ? orderPayload.discount_codes : []),
    ...(Array.isArray(orderPayload?.discountCodes) ? orderPayload.discountCodes : []),
  ];
  const discountCodes = rawDiscountCodes
    .map((item) => String(typeof item === "string" ? item : item?.code || "").trim().toUpperCase())
    .filter(Boolean);
  const normalizedShop = shopFromDest(shop);
  console.log("[scratch] redemption webhook received", {
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
  console.log("[scratch] reward marked redeemed", {
    shop: normalizedShop,
    orderId: orderPayload?.id,
    cardId: card.id,
  });
  return db.scratchCard.findUnique({ where: { id: card.id }, include: { rewardTemplate: true } });
}

export async function reconcileRedeemedScratchCards(shop, cards) {
  const candidates = cards.filter(
    (card) => card.status === "REVEALED" && card.discountId && card.discountCode,
  );
  if (!candidates.length) return cards;

  try {
    const { admin } = await unauthenticated.admin(shop);
    const response = await admin.graphql(
      `query ScratchDiscountUsage($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on DiscountCodeNode {
            id
            codeDiscount {
              ... on DiscountCodeBasic {
                asyncUsageCount
                usageLimit
              }
              ... on DiscountCodeFreeShipping {
                asyncUsageCount
                usageLimit
              }
            }
          }
        }
      }`,
      { variables: { ids: candidates.map((card) => card.discountId) } },
    );
    const payload = await response.json();
    if (payload.errors?.length) {
      console.error("[scratch] discount usage reconciliation failed", payload.errors);
      return cards;
    }

    const usedIds = new Set(
      (payload.data?.nodes || [])
        .filter((node) => {
          const usage = node?.codeDiscount;
          return Number(usage?.usageLimit) > 0 && Number(usage?.asyncUsageCount) >= Number(usage.usageLimit);
        })
        .map((node) => node.id),
    );
    if (!usedIds.size) return cards;

    const redeemedAt = new Date();
    await db.scratchCard.updateMany({
      where: { id: { in: candidates.filter((card) => usedIds.has(card.discountId)).map((card) => card.id) }, status: "REVEALED" },
      data: { status: "REDEEMED", redeemedAt },
    });
    console.log("[scratch] reconciled redeemed rewards", { shop, count: usedIds.size });
    return db.scratchCard.findMany({
      where: { id: { in: cards.map((card) => card.id) } },
      include: { rewardTemplate: true },
      orderBy: { issuedAt: "desc" },
    });
  } catch (error) {
    console.error("[scratch] discount usage reconciliation failed", error);
    return cards;
  }
}

function code() {
  return `SCR-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

export async function reconcileExpiredScratchCards(shop, existingCards) {
  const now = new Date();
  const cards =
    existingCards ||
    (await db.scratchCard.findMany({
      where: { shop, status: "REVEALED", expiresAt: { lte: now } },
    }));
  const expiredCards = cards.filter(
    (card) =>
      card.shop === shop &&
      card.status === "REVEALED" &&
      card.expiresAt &&
      card.expiresAt <= now,
  );
  if (!expiredCards.length) return [];

  const expiredIds = expiredCards.map((card) => card.id);
  await db.scratchCard.updateMany({
    where: {
      shop,
      id: { in: expiredIds },
      status: "REVEALED",
      expiresAt: { lte: now },
    },
    data: { status: "EXPIRED" },
  });

  const reconciledCards = await db.scratchCard.findMany({
    where: { shop, id: { in: expiredIds }, status: "EXPIRED" },
    include: { rewardTemplate: true },
  });
  const discounts = reconciledCards.filter((card) => card.discountId);
  if (discounts.length) {
    try {
      const { admin } = await unauthenticated.admin(shop);
      for (const card of discounts) {
        try {
          const response = await admin.graphql(
            `mutation DeactivateExpired($id: ID!) {
              discountCodeDeactivate(id: $id) {
                userErrors {
                  message
                }
              }
            }`,
            { variables: { id: card.discountId } },
          );
          const payload = await response.json();
          if (!payload.data?.discountCodeDeactivate && !payload.errors?.length) {
            console.error("[scratch] expired discount deactivation returned no result", {
              shop,
              discountId: card.discountId,
            });
            continue;
          }
          const errors = [
            ...(payload.errors || []),
            ...(payload.data?.discountCodeDeactivate?.userErrors || []),
          ];
          if (errors.length) {
            console.error("[scratch] expired discount deactivation failed", {
              shop,
              discountId: card.discountId,
              errors,
            });
          }
        } catch (error) {
          console.error("[scratch] expired discount deactivation failed", {
            shop,
            discountId: card.discountId,
            error,
          });
        }
      }
    } catch (error) {
      console.error("[scratch] expired discount deactivation failed", { shop, error });
    }
  }

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
  const expiredCards = await reconcileExpiredScratchCards(shop, cards);
  const expiredIds = new Set(expiredCards.map((card) => card.id));
  cards = cards.map((card) =>
    expiredIds.has(card.id) ? { ...card, status: "EXPIRED" } : card,
  );
  cards = await reconcileRedeemedScratchCards(shop, cards);
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

export async function revealCard(token, viewerSub) {
  const id = verifyToken(token);
  if (!id) return { state: "invalid" };
  let card = await db.scratchCard.findUnique({
    where: { id },
    include: { rewardTemplate: true },
  });
  if (!card) return { state: "invalid" };

  const viewer = customerIdFromViewer(viewerSub);
  if (card.customerId && viewer && idOf(card.customerId) !== viewer) {
    return { state: "invalid" };
  }

  if (card.status !== "ISSUED") return resultFor(card);
  const revealedAt = new Date();
  const expiresAt = expiryDateFromConfig(card.rewardTemplate, revealedAt);
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
      data: { status: "ISSUED", revealedAt: null, expiresAt: null },
    });
    throw error;
  }
}
