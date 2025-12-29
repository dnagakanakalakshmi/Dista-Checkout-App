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
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  console.log("[DEBUG] app._index.jsx loader called");
  console.log("[DEBUG] DATABASE_URL:", process.env.DATABASE_URL || "NOT SET");
  try {
    await authenticate.admin(request);
    console.log("[DEBUG] Admin authenticated successfully");
  } catch (err) {
    console.error("[ERROR] Admin authentication failed:", err);
    throw err;
  }
  return null;
};

export default function Index() {
  console.log("[DEBUG] app._index.jsx component rendered");
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
