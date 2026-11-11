import assert from "node:assert/strict";
import test from "node:test";
import { pickReward } from "../app/models/pick-reward.js";
import { signToken, verifyToken } from "../app/models/scratch-token.js";
import {
  hasIssueCap,
  customerIdFromViewer,
  customerIdLookupValues,
  expiryDateFromConfig,
  idOf,
  matchesRewardSegments,
  normalizeOrderId,
  orderPayloadFromAdmin,
  resultFor,
  shopFromDest,
  shopFromSessionToken,
  storefrontScratchUrl,
} from "../app/models/scratch-util.js";
import { scratchPage } from "../app/utils/scratch-page.server.js";

test("pickReward follows weights and eligibility", () => {
  const rewards = [
    { id: "a", active: true, weight: 50, minOrderValue: 0 },
    { id: "b", active: true, weight: 30, minOrderValue: 0 },
    { id: "c", active: true, weight: 20, minOrderValue: 100 },
  ];
  const low = new Set(Array.from({ length: 500 }, () => pickReward(rewards, 0).id));
  assert.deepEqual([...low].sort(), ["a", "b"]);
  const counts = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 100000; i += 1) counts[pickReward(rewards, 100).id] += 1;
  for (const [id, expected] of Object.entries({ a: 0.5, b: 0.3, c: 0.2 })) {
    assert.ok(Math.abs(counts[id] / 100000 - expected) < 0.01, `${id} outside 1%`);
  }
});

test("tampered scratch tokens are invalid", () => {
  const previous = process.env.SHOPIFY_API_SECRET;
  process.env.SHOPIFY_API_SECRET = "test-secret";
  const token = signToken("card-id");
  assert.equal(verifyToken(token), "card-id");
  assert.equal(verifyToken(`${token}x`), null);
  process.env.SHOPIFY_API_SECRET = previous;
});

test("order and shop ids normalize from GIDs, URLs, and custom domains", () => {
  assert.equal(idOf("gid://shopify/Order/123"), "123");
  assert.equal(normalizeOrderId("gid://shopify/Order/123"), "123");
  assert.equal(shopFromDest("https://demo.myshopify.com/admin"), "demo.myshopify.com");
  assert.equal(
    shopFromSessionToken({
      dest: "https://custom.example.com",
      iss: "https://demo.myshopify.com/admin",
    }),
    "demo.myshopify.com",
  );
  assert.equal(
    storefrontScratchUrl("demo.myshopify.com", "card.sig"),
    "https://demo.myshopify.com/apps/scratch/card.sig",
  );
  assert.equal(hasIssueCap({ maxIssued: undefined }), false);
  assert.equal(hasIssueCap({ maxIssued: null }), false);
  assert.equal(hasIssueCap({ maxIssued: 20 }), true);
  assert.equal(matchesRewardSegments({ segmentIds: [] }, []), true);
  assert.equal(matchesRewardSegments({ segmentIds: ["vip"] }, ["vip"]), true);
  assert.equal(matchesRewardSegments({ segmentIds: ["vip"] }, ["new"]), false);
  assert.equal(matchesRewardSegments({ segmentIds: ["vip"] }, new Set(["vip"])), true);
  assert.equal(customerIdFromViewer("gid://shopify/Customer/7"), "7");
  assert.equal(customerIdFromViewer("gid://shopify/Checkout/7"), "");
  assert.equal(customerIdFromViewer("7"), "7");
  assert.deepEqual(customerIdLookupValues("gid://shopify/Customer/7"), [
    "gid://shopify/Customer/7",
    "7",
  ]);
  assert.deepEqual(customerIdLookupValues("gid://shopify/Checkout/7"), []);
});

test("resultFor never re-issues a revealed or void card", () => {
  const displayFields = {
    label: "15% OFF",
    category: "Fashion",
    description: "On Ethnic Wear",
    imageUrl: "https://cdn.example.com/item.jpg",
    type: "PERCENT",
    value: 15,
  };
  assert.deepEqual(resultFor({ status: "ISSUED", rewardTemplate: displayFields }), {
    state: "issued",
    ...displayFields,
  });
  assert.equal(resultFor({ status: "VOID" }).state, "void");
  assert.equal(resultFor({ status: "EXPIRED" }).state, "expired");
  assert.deepEqual(
    resultFor({
      status: "REVEALED",
      discountCode: "SCR-1",
      rewardTemplate: displayFields,
    }),
    {
      state: "revealed",
      ...displayFields,
      code: "SCR-1",
      expiresAt: undefined,
    },
  );
  assert.equal(
    resultFor({
      status: "REVEALED",
      discountCode: "SCR-2",
      rewardTemplate: { ...displayFields, collectionHandle: "summer-collection" },
    }).collectionHandle,
    "summer-collection",
  );
  assert.equal(
    resultFor({
      status: "REVEALED",
      expiresAt: new Date(Date.now() - 1000),
      discountCode: "SCR-1",
    }).state,
    "expired",
  );
});

test("expiry duration starts at reveal time and supports calendar months", () => {
  const start = new Date("2026-01-31T12:00:00.000Z");
  assert.equal(
    expiryDateFromConfig({ expiryValue: 48, expiryUnit: "HOURS" }, start).toISOString(),
    "2026-02-02T12:00:00.000Z",
  );
  assert.equal(
    expiryDateFromConfig({ expiryValue: 1, expiryUnit: "MONTHS" }, start).toISOString(),
    "2026-02-28T12:00:00.000Z",
  );
});

test("admin order payload maps to webhook-shaped fields", () => {
  const payload = orderPayloadFromAdmin({
    id: "gid://shopify/Order/99",
    name: "#1001",
    currentTotalPriceSet: { shopMoney: { amount: "1499.00" } },
    customer: { id: "gid://shopify/Customer/7" },
    email: "customer@example.com",
  });
  assert.equal(payload.id, "99");
  assert.equal(payload.total_price, 1499);
  assert.equal(payload.customer.admin_graphql_api_id, "gid://shopify/Customer/7");
  assert.equal("email" in payload, false);
});

test("scratch page includes reveal interaction and reward CTAs", () => {
  const html = scratchPage({
    token: "card.sig",
    state: { state: "issued" },
    theme: "default",
  });
  assert.match(html, /Scratch to Reveal/);
  assert.match(html, /\/apps\/scratch\/reveal/);
  assert.match(html, /Tap to reveal/);
  assert.match(html, /Apply Now/);
  assert.match(html, /Shop Now/);
  assert.match(html, /canvas-confetti/);
});
