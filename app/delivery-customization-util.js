import prisma from "./db.server";

const LIST_DELIVERY_CUSTOMIZATIONS_QUERY = `
  query ListDeliveryCustomizations {
    deliveryCustomizations(first: 50) {
      nodes {
        id
        title
        enabled
      }
    }
  }
`;

const CREATE_WITH_HANDLE_MUTATION = `
  mutation CreateDeliveryCustomizationWithHandle($functionHandle: String!, $title: String!) {
    deliveryCustomizationCreate(
      deliveryCustomization: {
        functionHandle: $functionHandle
        title: $title
        enabled: true
      }
    ) {
      deliveryCustomization { id enabled }
      userErrors { field message }
    }
  }
`;

const UPDATE_DELIVERY_CUSTOMIZATION_MUTATION = `
  mutation UpdateDeliveryCustomization($id: ID!, $enabled: Boolean!) {
    deliveryCustomizationUpdate(
      id: $id
      deliveryCustomization: { enabled: $enabled }
    ) {
      deliveryCustomization { id enabled }
      userErrors { field message }
    }
  }
`;

async function adminGraphql202510ByShop(shop, query, variables = {}) {
  const session = await getLatestSessionForShop(shop);
  if (!session || !session.accessToken) {
    throw new Error("No active session found for shop");
  }

  const url = `https://${shop}/admin/api/2025-10/graphql.json`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": session.accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text();
    throwWithConsole("Admin GraphQL HTTP error", { status: response.status, body: text });
  }

  return response.json();
}

export async function getLatestSessionForShop(shop) {
  return prisma.session.findFirst({
    where: { shop },
    orderBy: { expires: "desc" },
  });
}

export async function runDeliveryCustomizationCreate(shop, functionHandle, title = "Estimated Delivery Dates") {
  const session = await getLatestSessionForShop(shop);
  if (!session || !session.accessToken) {
    throw new Error("No active session found for shop");
  }
  const ADMIN_TOKEN = session.accessToken;
  const SHOP_DOMAIN = shop;
  const mutation = `mutation deliveryCustomizationCreate($functionHandle: String!, $title: String!) {
    deliveryCustomizationCreate(deliveryCustomization: {
      functionHandle: $functionHandle
      title: $title
      enabled: true
    }) {
      deliveryCustomization { id }
      userErrors { message }
    }
  }`;
  const url = `https://${SHOP_DOMAIN}/admin/api/2025-10/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ADMIN_TOKEN,
    },
    body: JSON.stringify({ query: mutation, variables: { functionHandle, title } }),
  });
  if (!res.ok) throw new Error(`Admin GraphQL error ${res.status}`);
  const j = await res.json();
  if (j.errors && j.errors.length) throw new Error(JSON.stringify(j.errors));
  if (j.data.deliveryCustomizationCreate.userErrors.length) {
    throw new Error(j.data.deliveryCustomizationCreate.userErrors.map(e => e.message).join(", "));
  }
  return j.data.deliveryCustomizationCreate.deliveryCustomization.id;
}

function formatUserErrors(userErrors) {
  const errors = userErrors ?? [];
  return errors.map((e) => e?.message).filter(Boolean).join(", ");
}

function throwWithConsole(operationName, payload) {
  // Log full payload once so server logs contain complete Shopify error details.
  console.error(`[DeliveryCustomization] ${operationName} failed`, payload);
  throw new Error(`${operationName} failed: ${JSON.stringify(payload)}`);
}

async function getDeliveryCustomizations(shop) {
  const result = await adminGraphql202510ByShop(shop, LIST_DELIVERY_CUSTOMIZATIONS_QUERY);
  if (result?.errors?.length) {
    throwWithConsole("List delivery customizations", result);
  }
  return result?.data?.deliveryCustomizations?.nodes ?? [];
}

async function createDeliveryCustomizationWithHandle(shop, functionHandle, title) {
  const createWithHandleResult = await adminGraphql202510ByShop(
    shop,
    CREATE_WITH_HANDLE_MUTATION,
    { functionHandle, title },
  );

  if (createWithHandleResult?.errors?.length) {
    throwWithConsole("Create delivery customization (functionHandle)", createWithHandleResult);
  }

  const userErrors = createWithHandleResult?.data?.deliveryCustomizationCreate?.userErrors ?? [];
  if (userErrors.length) {
    throwWithConsole("Create delivery customization (functionHandle userErrors)", {
      userErrors,
      message: formatUserErrors(userErrors),
    });
  }
}

export async function ensureDeliveryCustomizationExists(shop, { title, functionHandle }) {
  const customizations = await getDeliveryCustomizations(shop);
  const match = customizations.find((node) => node?.title === title);

  if (!match) {
    await createDeliveryCustomizationWithHandle(shop, functionHandle, title);
    return { created: true, enabled: true };
  }

  return { created: false, enabled: match.enabled };
}

export async function isDeliveryCustomizationEnabledByTitle(shop, title) {
  const customizations = await getDeliveryCustomizations(shop);
  const match = customizations.find((node) => node?.title === title);
  return Boolean(match?.enabled);
}

export async function setDeliveryCustomizationEnabledByTitle(shop, {
  title,
  functionHandle,
  enabled,
}) {
  const customizations = await getDeliveryCustomizations(shop);
  const match = customizations.find((node) => node?.title === title);

  if (enabled) {
    if (!match) {
      await createDeliveryCustomizationWithHandle(shop, functionHandle, title);
      return;
    }
    if (!match.enabled) {
      const updateResult = await adminGraphql202510ByShop(
        shop,
        UPDATE_DELIVERY_CUSTOMIZATION_MUTATION,
        { id: match.id, enabled: true },
      );
      if (updateResult?.errors?.length) {
        throwWithConsole("Enable delivery customization", updateResult);
      }
      const userErrors = updateResult?.data?.deliveryCustomizationUpdate?.userErrors ?? [];
      if (userErrors.length) {
        throwWithConsole("Enable delivery customization userErrors", {
          userErrors,
          message: formatUserErrors(userErrors),
        });
      }
    }
    return;
  }

  if (match?.enabled) {
    const updateResult = await adminGraphql202510ByShop(
      shop,
      UPDATE_DELIVERY_CUSTOMIZATION_MUTATION,
      { id: match.id, enabled: false },
    );
    if (updateResult?.errors?.length) {
      throwWithConsole("Disable delivery customization", updateResult);
    }
    const userErrors = updateResult?.data?.deliveryCustomizationUpdate?.userErrors ?? [];
    if (userErrors.length) {
      throwWithConsole("Disable delivery customization userErrors", {
        userErrors,
        message: formatUserErrors(userErrors),
      });
    }
  }
}
