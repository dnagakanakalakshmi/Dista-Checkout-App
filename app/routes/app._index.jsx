import {
  Page,
  BlockStack,
  Card,
  Text,
  InlineStack,
  Button,
  Box,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import shopify from "../shopify.server";
import { runDeliveryCustomizationCreate } from "../delivery-customization-util";


export const loader = async ({ request }) => {
  const { admin, session } = await shopify.authenticate.admin(request);
  const { shop } = session;

  // Check if delivery customizations are already attached
  let attached = false;
  let remoteAttached = false;
  let error = null;
  try {

    const query = `{
      deliveryCustomizations(first: 10) {
        nodes { id enabled }
      }
    }`;
    const resp = await admin.graphql(query);
    const data = await resp.json();
    const nodes = data?.data?.deliveryCustomizations?.nodes || [];
    // Since we can't check handle, just check if any enabled customization exists
    attached = nodes.some(n => n.enabled);

    // If not attached, attach both functions
    if (!attached) {
      await runDeliveryCustomizationCreate(shop, "delivery-customization", "Estimated Delivery Dates");
      attached = true;
    }

    // Attach remote-delivery-options function
    if(!remoteAttached){
      await runDeliveryCustomizationCreate(shop, "remote-delivery-options", "Remote Area Delivery Filter");
      remoteAttached = true;
    }
  } catch (e) {
    console.error("Error in delivery customization loader:", e);
    error = e.message || String(e);
  }

  return { attached, remoteAttached, error };
};

export default function Index() {
  return (
    <Page>
      <TitleBar title="Checkout App Dista" />
      <Box paddingBlock="600">
        <InlineStack align="center" blockAlign="center">
          <Box maxWidth="640px" width="100%">
            <Card>
              <BlockStack gap="300">
                <Text as="h1" variant="headingLg" alignment="center">
                  Welcome to Checkout App Dista
                </Text>
                <Text alignment="center">
                  Configure settings for dispatch dates and estimated delivery dates in your checkout experience.
                </Text>
                <InlineStack align="center">
                  <Button url="/app/datesinput" variant="primary">
                    Configure here
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Box>
        </InlineStack>
      </Box>
    </Page>
  );
}
