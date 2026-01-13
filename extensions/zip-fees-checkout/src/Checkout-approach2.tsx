import {
  reactExtension,
  useApplyCartLinesChange,
  useCartLines,
  useShippingAddress,
  useApi,
  useShop,
  // useBillingAddress,
  // useDiscountAllocations,
  // useDiscountCodes,
  useEmail,
  useDeliveryGroups,
  useCustomer,
} from "@shopify/ui-extensions-react/checkout";
import * as React from "react";

const FEE_MARKER_KEY = "__zip_fee_internal";
const FEE_MARKER_VALUE = "true";
const BACKEND_PRICE_API_URL = "https://shopify-app-dista-checkout.dista.care/api/remote-area";
const BACKEND_VARIANT_API_URL = "https://shopify-app-dista-checkout.dista.care/app/getVariant";

export default reactExtension("purchase.checkout.block.render", () => <ZipFeeApproach2 />);

function ZipFeeApproach2() {
  const applyChange = useApplyCartLinesChange();
  const lines = useCartLines();
  const address = useShippingAddress();
  // const billingAddress = useBillingAddress();
  const api = useApi();
  const shop = useShop();
  // const discountAllocations = useDiscountAllocations();
  // const discountCodes = useDiscountCodes();
  const email = useEmail();
  const deliveryGroups = useDeliveryGroups();
  const customer = useCustomer();
  
  // Extract stable values for useEffect dependencies to prevent infinite loops
  const selectedDeliveryHandle = deliveryGroups?.[0]?.selectedDeliveryOption?.handle;

  React.useEffect(() => {
    void syncFee();
  }, [address?.zip, address?.countryCode, selectedDeliveryHandle]);

  // Helper function to parse shipping days from delivery option text
  function parseShippingDaysFromText(text) {
    if (!text || typeof text !== 'string') return null;
    const t = text.replace(/[,]/g, ' ').toLowerCase();

    // Range like '3-5 business day' or '3 to 5 business days'
    const rangeMatch = t.match(/(\d{1,2})\s*(?:[-–—]|to)\s*(\d{1,2})\s*(?:business|working)?\s*day/);
    if (rangeMatch) {
      const min = Number(rangeMatch[1]);
      const max = Number(rangeMatch[2]);
      if (!isNaN(min) && !isNaN(max)) return { min, max };
    }

    // Plus style '2+ business day(s)'
    const plusMatch = t.match(/(\d{1,2})\s*\+\s*(?:business|working)?\s*day/);
    if (plusMatch) {
      const min = Number(plusMatch[1]);
      if (!isNaN(min)) return { min, max: min + 2 };
    }

    // Single number '3 business day' or '3 days'
    const singleMatch = t.match(/(?:about\s*)?(\d{1,2})\s*(?:business|working)?\s*day/);
    if (singleMatch) {
      const n = Number(singleMatch[1]);
      if (!isNaN(n)) return { min: n, max: n };
    }

    return null;
  }

  // Determine if selected delivery option is express (fastest option)
  function isExpressShipping() {
    // Find the current delivery group
    const currentGroup = deliveryGroups?.[0];
    if (!currentGroup) return false;

    const selectedOption = currentGroup.selectedDeliveryOption;
    const allOptions = currentGroup.deliveryOptions || [];

    if (!selectedOption || allOptions.length === 0) return false;

    // Parse days for all options - use code first (contains clean business day info), then title, then handle
    const optionsWithDays = allOptions.map(opt => {
      const textToParse = (opt as any).code || (opt as any).title || opt.handle || "";
      const parsed = parseShippingDaysFromText(textToParse);
      return {
        handle: opt.handle,
        code: (opt as any).code,
        minDays: parsed?.min || 999,
      };
    });

    // Find the minimum days across all options
    const minDaysAvailable = Math.min(...optionsWithDays.map(o => o.minDays));
    
    // Find the selected option's code by matching handle
    const selectedOptionFull = allOptions.find(opt => opt.handle === selectedOption.handle);
    const selectedTextToParse = (selectedOptionFull as any)?.code || (selectedOption as any).title || selectedOption.handle || "";
    const selectedParsed = parseShippingDaysFromText(selectedTextToParse);
    const selectedMinDays = selectedParsed?.min || 999;

    return selectedMinDays === minDaysAvailable && minDaysAvailable < 999;
  }

  async function syncFee() {

    // External calls continue below via BACKEND_PRICE_API_URL and BACKEND_VARIANT_API_URL

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

    // Call backend API to get PRICE with comprehensive checkout details
    try {
      const priceResponse = await fetch(BACKEND_PRICE_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // Shop & Session Info
          shop: shop.myshopifyDomain,
          
          // Customer Info
          email: email || "",
          customer: customer ? {
            id: customer.id,
            //fullName: customer.fullName || "",
            firstName: customer.firstName || "",
            lastName: customer.lastName || "",
            email: customer.email || "",
            phone: customer.phone || "",
            //acceptsMarketing: customer.acceptsMarketing || false,
            //image: customer.image || null,
          } : null,
          
          // Shipping Address
          shippingAddress: {
            firstName: address?.firstName || "",
            lastName: address?.lastName || "",
            company: address?.company || "",
            address1: address?.address1 || "",
            address2: address?.address2 || "",
            city: address?.city || "",
            provinceCode: address?.provinceCode || "",
            postalCode: address?.zip || "",
            countryCode: address?.countryCode || "",
            phone: address?.phone || "",
          },
          
          // Delivery Groups
          // deliveryGroups: deliveryGroups.map((group) => ({
          //   groupType: group.groupType,
          //   isDeliveryRequired: group.isDeliveryRequired,
          //   selectedDeliveryOption: group.selectedDeliveryOption
          //     ? {
          //         handle: group.selectedDeliveryOption.handle,
          //       }
          //     : null,
          //   deliveryOptions: group.deliveryOptions.map((option) => ({
          //     handle: option.handle,
          //   })),
          // })),
          
          // Billing Address
          // billingAddress: {
          //   firstName: billingAddress?.firstName || "",
          //   lastName: billingAddress?.lastName || "",
          //   company: billingAddress?.company || "",
          //   address1: billingAddress?.address1 || "",
          //   address2: billingAddress?.address2 || "",
          //   city: billingAddress?.city || "",
          //   provinceCode: billingAddress?.provinceCode || "",
          //   postalCode: billingAddress?.zip || "",
          //   countryCode: billingAddress?.countryCode || "",
          //   phone: billingAddress?.phone || "",
          // },
          
          // Cart Details
          cartSubtotal: subtotal.toString(),
          lineItems: lines.map((line) => ({
            id: line.id,
            quantity: line.quantity,
            sku: line.merchandise.sku,
            price: line.cost.totalAmount.amount,
            totalAmount: line.cost.totalAmount.amount,
            variant: {
              id: line.merchandise.id,
            },
          })),
          
          // Discount & Coupon Info
          // appliedDiscountCodes: discountCodes.map((code) => code.code),
          // discountAllocations: discountAllocations.map((discount) => ({
          //   amount: discount.discountedAmount.amount,
          // })),
          
          // Localization & Currency
          currencyCode,
          language: api.localization.language.current.isoCode,
          
          // Store Info
          storeName: shop.name,
        }),
      });

      const priceData = await priceResponse.json();
      console.log("Surcharge price response data:", priceData);

      // Check if remote area surcharge applies
      if (!priceData.isRemoteArea) {
        // Not a remote area, remove existing fee line if present
        if (feeLine) {
          await applyChange({ type: "removeCartLine", id: feeLine.id, quantity: feeLine.quantity });
        }
        return;
      }

      // Determine which charge to use based on shipping speed
      const isExpress = isExpressShipping();
      const targetPrice = isExpress 
        ? parseFloat(priceData.expressCharge || 0)
        : parseFloat(priceData.regularCharge || 0);


      if (!targetPrice || targetPrice <= 0) {
        // No valid surcharge, remove existing fee line if present
        if (feeLine) {
          await applyChange({ type: "removeCartLine", id: feeLine.id, quantity: feeLine.quantity });
        }
        return;
      }

      // Backend gave us the price, call another backend route to get variant ID
      const variantId = await getVariantIdFromBackend(targetPrice, subtotal);

      if (!variantId) {
        console.error("Could not find variant for price:", targetPrice);
        if (feeLine) {
          await applyChange({ type: "removeCartLine", id: feeLine.id, quantity: feeLine.quantity });
        }
        return;
      }

      // Check if fee line already exists with the same variant
      if (feeLine) {
        const currentVariantId = feeLine.merchandise.id;
        if (currentVariantId === variantId) {
          // Same variant, no need to update
          return;
        }
        // Different variant, remove old one
        await applyChange({ type: "removeCartLine", id: feeLine.id, quantity: feeLine.quantity });
      }

      // Add the new surcharge variant
      await applyChange({
        type: "addCartLine",
        merchandiseId: variantId,
        quantity: 1,
        attributes: [
          { key: FEE_MARKER_KEY, value: FEE_MARKER_VALUE },
          { key: "title", value: priceData.title || "Surcharge" },
        ],
      });
    } catch (error) {
      console.error("Failed to fetch surcharge price:", error);
      // On error, keep existing state (don't remove fee line)
    }
  }

  // Call backend to get variant ID for the target price
  async function getVariantIdFromBackend(targetPrice, subtotal) {
    try {
      const response = await fetch(BACKEND_VARIANT_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          shop: shop.myshopifyDomain,
          targetPrice: targetPrice,
          // Pass comprehensive details for variant selection logic
          shippingAddress: {
            countryCode: address?.countryCode,
            provinceCode: address?.provinceCode,
            postalCode: address?.zip,
          },
          cartSubtotal: subtotal.toString(),
          currencyCode: api.localization.currency.current.isoCode,
        }),
      });

      const data = await response.json();
      return data.ok ? data.variantId : null;
    } catch (error) {
      console.error("Error fetching variant from backend:", error);
      return null;
    }
  }

  return null;
}
