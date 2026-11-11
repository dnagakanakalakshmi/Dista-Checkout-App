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
import { ensureDeliveryCustomizationExists } from "../delivery-customization-util";


export const loader = async ({ request }) => {
  const { session } = await shopify.authenticate.admin(request);
  const { shop } = session;

  let attached = false;
  let remoteAttached = false;
  let error = null;
  try {

    const est = await ensureDeliveryCustomizationExists(shop, {
      title: "Estimated Delivery Dates",
      functionHandle: "delivery-customization",
    });
    attached = est.enabled;

    const remote = await ensureDeliveryCustomizationExists(shop, {
      title: "Remote Area Delivery Filter",
      functionHandle: "remote-delivery-options",
    });
    remoteAttached = remote.enabled;

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
