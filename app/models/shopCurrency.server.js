// app/models/shopCurrency.server.js
//
// The store's base currency. Every merchant-entered amount in this app
// (flat discount value, max discount cap, min/max purchase amount) is in
// this currency; the Functions convert to the buyer's currency at checkout.
// Used to label admin fields and to replace the old hardcoded "$" in the
// dashboard and CSV exports.

export async function getShopCurrencyCode(admin) {
  try {
    const response = await admin.graphql(
      `#graphql
        query ShopCurrencyCode {
          shop {
            currencyCode
          }
        }`,
    );
    const json = await response.json();
    return json.data?.shop?.currencyCode || "";
  } catch {
    // Never fail a page or export just because the label couldn't load.
    return "";
  }
}
