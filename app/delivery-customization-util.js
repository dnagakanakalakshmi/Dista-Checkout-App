import prisma from "./db.server";

export async function getLatestSessionForShop(shop) {
  return prisma.session.findFirst({
    where: { shop },
    orderBy: { expires: "desc" },
  });
}

export async function runDeliveryCustomizationCreate(shop, functionHandle) {
  const session = await getLatestSessionForShop(shop);
  if (!session || !session.accessToken) {
    throw new Error("No active session found for shop");
  }
  const ADMIN_TOKEN = session.accessToken;
  const SHOP_DOMAIN = shop;
  const mutation = `mutation deliveryCustomizationCreate($functionHandle: String!) {
    deliveryCustomizationCreate(deliveryCustomization: {
      functionHandle: $functionHandle
      title: \"Estimated Delivery Dates\"
      enabled: true
    }) {
      deliveryCustomization { id }
      userErrors { message }
    }
  }`;
  const url = `https://${SHOP_DOMAIN}/admin/api/2025-07/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ADMIN_TOKEN,
    },
    body: JSON.stringify({ query: mutation, variables: { functionHandle } }),
  });
  if (!res.ok) throw new Error(`Admin GraphQL error ${res.status}`);
  const j = await res.json();
  if (j.errors && j.errors.length) throw new Error(JSON.stringify(j.errors));
  if (j.data.deliveryCustomizationCreate.userErrors.length) {
    throw new Error(j.data.deliveryCustomizationCreate.userErrors.map(e => e.message).join(", "));
  }
  return j.data.deliveryCustomizationCreate.deliveryCustomization.id;
}
