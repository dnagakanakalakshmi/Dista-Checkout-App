import { json } from "@remix-run/node";
import prisma from "../db.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const SURCHARGE_PRODUCT_ID = "9416647966949";

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

    // Fetch product variants from Shopify Admin API using GraphQL for market pricing
    const shopDomain = shop;
    const accessToken = session.accessToken;
    const apiVersion = "2025-01";

    // Build GraphQL query with contextual pricing
    const graphqlQuery = `
      query getProductVariants($country: CountryCode) {
        product(id: "gid://shopify/Product/${SURCHARGE_PRODUCT_ID}") {
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

    console.log("Fetching variants with market context:", variables);

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
      console.error("GraphQL errors:", data.errors);
      return json(
        { ok: false, error: "GraphQL query failed" },
        { status: 500, headers: CORS_HEADERS }
      );
    }

    const variants = data.data?.product?.variants?.edges || [];
    console.log('Fetched These Variants Details:', variants);

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

    // Log all available variant prices for debugging
    console.log("Variant Selection Debug:", {
      targetPrice,
      requestedCurrency: currencyCode,
      requestedCountry: shippingAddress?.countryCode,
      availableVariants: variantsWithPrice.map((v) => ({
        id: v.id,
        price: v.price,
        currency: v.currencyCode,
      })),
    });

    // Find first variant >= targetPrice, or use highest if none found
    const selectedVariant = variantsWithPrice.find((v) => v.price >= targetPrice)
      || variantsWithPrice[variantsWithPrice.length - 1];

    console.log("Selected Variant:", {
      targetPrice,
      selectedVariantId: selectedVariant.id,
      selectedVariantPrice: selectedVariant.price,
    });



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
