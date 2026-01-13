import { json } from "@remix-run/node";
import prisma from "../db.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Handle preflight OPTIONS request
export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
};

export const action = async ({ request }) => {
  try {
    if (request.method !== "POST") {
      return json(
        { ok: false, error: "Method not allowed" },
        { status: 405, headers: CORS_HEADERS }
      );
    }

    const body = await request.json();
    const {
      shop,
      targetPrice,
      currencyCode,
      shippingAddress,
    } = body;

    if (!shop || targetPrice === undefined) {
      return json(
        { ok: false, error: "Missing required fields: shop, targetPrice" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    // Lookup session for shop to get Admin access token
    const session = await prisma.session.findFirst({
      where: { shop },
      orderBy: { expires: "desc" },
    });

    if (!session || !session.accessToken) {
      return json(
        { ok: false, error: "No active session found for shop" },
        { status: 401, headers: CORS_HEADERS }
      );
    }

    // Fetch Zip Fee Extension config metafield from Shopify Admin API (to get surcharge product)
    const shopDomain = shop;
    const accessToken = session.accessToken;
    const apiVersion = "2025-01";

    const metafieldQuery = `
      query getZipFeeConfig {
        shop {
          metafield(namespace: "distacart", key: "zip_fee_extension") {
            value
          }
        }
      }
    `;

    const metafieldResp = await fetch(
      `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: metafieldQuery }),
      }
    );  

    if (!metafieldResp.ok) {
      const errorText = await metafieldResp.text();
      console.error("Shopify GraphQL metafield error:", errorText);
      return json(
        { ok: false, error: "Failed to fetch zip fee configuration" },
        { status: 500, headers: CORS_HEADERS }
      );
    }

    const metafieldData = await metafieldResp.json();
    
    const rawZipValue =
      metafieldData?.data?.shop?.metafield?.value ?? null;

    if (!rawZipValue) {
      return json(
        { ok: false, error: "Zip fee configuration not found" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    let zipConfig;
    try {
      const outer = JSON.parse(rawZipValue);
      zipConfig = typeof outer === "string" ? JSON.parse(outer) : outer;
    } catch (e) {
      console.error("DEBUG: Failed to parse zip fee config metafield:", e);
      console.error("DEBUG: Error details:", e.message, e.stack);
      return json(
        { ok: false, error: "Invalid zip fee configuration format" },
        { status: 500, headers: CORS_HEADERS }
      );
    }

    const surchargeProductId = zipConfig?.productId;

    if (!surchargeProductId) {
      return json(
        { ok: false, error: "Surcharge product ID not configured" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    // Build GraphQL query with contextual pricing for the configured surcharge product
    const productGid = `gid://shopify/Product/${surchargeProductId}`;
    
    const graphqlQuery = `
      query getProductVariants($country: CountryCode) {
        product(id: "${productGid}") {
          id
          title
          variants(first: 250) {
            edges {
              node {
                id
                title
                contextualPricing(context: { country: $country }) {
                  price {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      }
    `;

    const variables = {
      country: shippingAddress?.countryCode || null,
    };

    const response = await fetch(
      `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: graphqlQuery,
          variables: variables,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Shopify GraphQL API error:", errorText);
      return json(
        { ok: false, error: "Failed to fetch product variants" },
        { status: 500, headers: CORS_HEADERS }
      );
    }

    const data = await response.json();
    
    if (data.errors) {
      console.error("DEBUG: GraphQL errors:", data.errors);
      return json(
        { ok: false, error: "GraphQL query failed" },
        { status: 500, headers: CORS_HEADERS }
      );
    }
    
    const variants = data.data?.product?.variants?.edges || [];

    if (variants.length === 0) {
      return json(
        { ok: false, error: "No variants found for surcharge product" },
        { status: 404, headers: CORS_HEADERS }
      );
    }

    // Find the variant with the nearest price (rounded up) - optimized
    const variantsWithPrice = variants
      .map((edge) => ({
        id: edge.node.id,
        price: parseFloat(edge.node.contextualPricing.price.amount),
        currencyCode: edge.node.contextualPricing.price.currencyCode,
      }))
      .sort((a, b) => a.price - b.price); // Sort once ascending


    // Find first variant >= targetPrice, or use highest if none found
    const selectedVariant = variantsWithPrice.find((v) => v.price >= targetPrice)
      || variantsWithPrice[variantsWithPrice.length - 1];

    return json(
      {
        ok: true,
        variantId: selectedVariant.id,
        selectedPrice: selectedVariant.price.toFixed(2),
      },
      { status: 200, headers: CORS_HEADERS }
    );
  } catch (error) {
    console.error("Error in getVariant API:", error);
    return json(
      { ok: false, error: error.message || "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
};
