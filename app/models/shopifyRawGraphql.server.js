// app/models/shopifyRawGraphql.server.js
//
// Bypasses the shopify-app-remix admin.graphql() client to hit a specific
// API version directly. Use ONLY where the installed @shopify/shopify-api
// package's ApiVersion enum doesn't yet include the version you need —
// e.g. discountCodeAppCreate's `tags` field, which only exists on
// DiscountCodeAppInput starting 2026-04, ahead of what our pinned
// shopify-api package knows about.
export async function graphqlRaw(shop, accessToken, query, variables, apiVersion = "2026-04") {
  const response = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await response.json();

  if (!response.ok) {
    throw new Response(
      `Raw GraphQL request failed (${response.status}): ${JSON.stringify(json)}`,
      { status: response.status },
    );
  }

  return json;
}