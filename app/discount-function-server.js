import prisma from './db.server';

const DISCOUNT_TITLE = "Tiered Line Items Discount";
const DISCOUNT_FUNCTION_HANDLE = "tiered-discount";
const DISCOUNT_API_VERSION = '2026-01';

const GET_AUTOMATIC_APP_DISCOUNTS = `#graphql
  query getAutomaticAppDiscounts($first: Int!, $query: String) {
    discountNodes(first: $first, query: $query) {
      edges {
        node {
          id
          discount {
            __typename
            ... on DiscountAutomaticApp {
              title
              status
            }
          }
        }
      }
    }
  }
`;

const CREATE_AUTOMATIC_APP_DISCOUNT = `#graphql
  mutation createAutomaticAppDiscount(
    $automaticAppDiscount: DiscountAutomaticAppInput!
  ) {
    discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
      automaticAppDiscount {
        discountId
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const ACTIVATE_AUTOMATIC_DISCOUNT = `#graphql
  mutation activateAutomaticDiscount($id: ID!) {
    discountAutomaticActivate(id: $id) {
      automaticDiscountNode {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const DEACTIVATE_AUTOMATIC_DISCOUNT = `#graphql
  mutation deactivateAutomaticDiscount($id: ID!) {
    discountAutomaticDeactivate(id: $id) {
      automaticDiscountNode {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

async function getLatestSessionForShop(shop) {
  return prisma.session.findFirst({
    where: { shop },
    orderBy: { expires: 'desc' },
  });
}

async function graphqlJson(shop, query, variables = {}) {
  const session = await getLatestSessionForShop(shop);
  if (!session?.accessToken) {
    throw new Error('No active session found for shop');
  }

  const response = await fetch(`https://${shop}/admin/api/${DISCOUNT_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': session.accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discount GraphQL HTTP error ${response.status}: ${body}`);
  }

  return response.json();
}

function assertNoUserErrors(errors, context) {
  if (errors?.length) {
    const firstError = errors[0]?.message || "Unknown Shopify user error.";
    throw new Error(`${context}: ${firstError}`);
  }
}

function toEnabled(status) {
  return String(status || "").toUpperCase() === "ACTIVE";
}

async function findManagedDiscount(shop) {
  const responseJson = await graphqlJson(shop, GET_AUTOMATIC_APP_DISCOUNTS, {
    first: 50,
    query: `method:automatic title:\"${DISCOUNT_TITLE}\"`,
  });

  const edges = responseJson.data?.discountNodes?.edges ?? [];

  const match = edges.find((edge) => {
    const discount = edge?.node?.discount;
    return (
      discount?.__typename === "DiscountAutomaticApp" &&
      discount.title === DISCOUNT_TITLE
    );
  });

  if (!match) {
    return null;
  }

  return {
    id: match.node.id,
    status: match.node.discount?.status,
  };
}

export async function getDiscountFunctionStatus(shop) {
  const discount = await findManagedDiscount(shop);

  return {
    exists: Boolean(discount?.id),
    enabled: toEnabled(discount?.status),
    discountId: discount?.id ?? null,
  };
}

export async function enableDiscountFunction(shop) {
  let discount = await findManagedDiscount(shop);
  let created = false;

  if (!discount) {
    const createJson = await graphqlJson(shop, CREATE_AUTOMATIC_APP_DISCOUNT, {
      automaticAppDiscount: {
        title: DISCOUNT_TITLE,
        functionHandle: DISCOUNT_FUNCTION_HANDLE,
        discountClasses: ["PRODUCT"],
        startsAt: new Date().toISOString(),
        combinesWith: {
          orderDiscounts: true,
          productDiscounts: true,
          shippingDiscounts: true,
        },
      },
    });

    const createPayload = createJson.data?.discountAutomaticAppCreate;
    assertNoUserErrors(
      createPayload?.userErrors,
      "Failed to create automatic app discount",
    );

    const createdDiscountId = createPayload?.automaticAppDiscount?.discountId;
    if (!createdDiscountId) {
      throw new Error("Failed to create automatic app discount: Missing discountId.");
    }

    created = true;
    discount = {
      id: createdDiscountId,
      status: "ACTIVE",
    };
  }

  if (!toEnabled(discount.status)) {
    const activateJson = await graphqlJson(shop, ACTIVATE_AUTOMATIC_DISCOUNT, {
      id: discount.id,
    });

    const activatePayload = activateJson.data?.discountAutomaticActivate;
    assertNoUserErrors(
      activatePayload?.userErrors,
      "Failed to activate automatic app discount",
    );
  }

  return {
    enabled: true,
    created,
    discountId: discount.id,
  };
}

export async function disableDiscountFunction(shop) {
  const discount = await findManagedDiscount(shop);

  if (!discount) {
    return {
      enabled: false,
      existed: false,
      discountId: null,
    };
  }

  if (toEnabled(discount.status)) {
    const deactivateJson = await graphqlJson(shop, DEACTIVATE_AUTOMATIC_DISCOUNT, {
      id: discount.id,
    });

    const deactivatePayload = deactivateJson.data?.discountAutomaticDeactivate;
    assertNoUserErrors(
      deactivatePayload?.userErrors,
      "Failed to deactivate automatic app discount",
    );
  }

  return {
    enabled: false,
    existed: true,
    discountId: discount.id,
  };
}
