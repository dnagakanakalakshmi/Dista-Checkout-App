import {
  reactExtension,
  useApplyCartLinesChange,
  useCartLines,
  useShippingAddress,
  useApi,
  useShop,
} from "@shopify/ui-extensions-react/checkout";
import * as React from "react";

const FEE_MARKER_KEY = "__zip_fee_internal";
const FEE_MARKER_VALUE = "true";
const BACKEND_API_URL = "https://rentals-nature-hundreds-answers.trycloudflare.com/api/surcharge"; // TODO: Update with your actual app URL

export default reactExtension("purchase.checkout.block.render", () => <ZipFee />);

function ZipFee() {
  const applyChange = useApplyCartLinesChange();
  const lines = useCartLines();
  const address = useShippingAddress();
  const api = useApi();
  const shop = useShop();

  React.useEffect(() => {
    void syncFee();
  }, [address?.zip, address?.countryCode]);

  async function syncFee() {
    // Find existing fee line
    const feeLine = lines.find((line) =>
      line.attributes?.some((a) => a.key === FEE_MARKER_KEY && a.value === FEE_MARKER_VALUE)
    );

    // Remove fee if no zip/country
    if (!address?.zip || !address?.countryCode) {
      if (feeLine) {
        await applyChange({ type: "removeCartLine", id: feeLine.id, quantity: feeLine.quantity });
      }
      return;
    }

    // Calculate subtotal (excluding existing fee line) - optimized with single pass
    const subtotal = lines.reduce((sum, l) => 
      l.id !== feeLine?.id ? sum + Number(l.cost.totalAmount.amount) : sum, 0
    );

    if (subtotal <= 0) return;

    const currencyCode = api.localization.currency.current.isoCode;

    // Call backend API to get the appropriate variant ID
    try {
      const response = await fetch(BACKEND_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          shop: shop.myshopifyDomain,
          country: address.countryCode,
          zipCode: address.zip,
          cartSubtotal: subtotal.toString(),
          currencyCode: currencyCode,
        }),
      });

      const data = await response.json();

      if (!data.ok || !data.variantId) {
        // No surcharge applicable, remove existing fee line if present
        if (feeLine) {
          await applyChange({ type: "removeCartLine", id: feeLine.id, quantity: feeLine.quantity });
        }
        return;
      }

      // Check if fee line already exists with the same variant
      if (feeLine) {
        const currentVariantId = feeLine.merchandise.id;
        if (currentVariantId === data.variantId) {
          // Same variant, no need to update
          return;
        }
        // Different variant, remove old one
        await applyChange({ type: "removeCartLine", id: feeLine.id, quantity: feeLine.quantity });
      }

      // Add the new surcharge variant
      await applyChange({
        type: "addCartLine",
        merchandiseId: data.variantId,
        quantity: 1,
        attributes: [
          { key: FEE_MARKER_KEY, value: FEE_MARKER_VALUE },
          { key: "title", value: data.title || "Surcharge" },
        ],
      });
    } catch (error) {
      console.error("Failed to fetch surcharge variant:", error);
      // On error, keep existing state (don't remove fee line)
    }
  }

  return null;
}