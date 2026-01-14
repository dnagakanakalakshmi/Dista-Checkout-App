import { useEffect } from 'react';
import {
  reactExtension,
  useApi,
  useApplyAttributeChange,
  useShippingAddress,
  useCustomer,
  useCartLines,
  useShop,
  useEmail,
} from '@shopify/ui-extensions-react/checkout';

export default reactExtension(
  'purchase.checkout.block.render',
  () => <RemoteCartAttribute />
);

// Simple in-memory cache for remote area checks
const remoteCache = new Map();

function RemoteCartAttribute() {
  const api = useApi();
  const shop = useShop();
  const applyAttributeChange = useApplyAttributeChange();
  const address = useShippingAddress();
  const customer = useCustomer();
  const lines = useCartLines();
  const email = useEmail();

  useEffect(() => {
    async function checkRemoteArea() {
      if (!address?.countryCode) {
        return;
      }

      try {
        const cacheKey = `${address.countryCode}-${address.zip}`;
        
        // Check cache first for instant response
        if (remoteCache.has(cacheKey)) {
          const cachedValue = remoteCache.get(cacheKey);
          await applyAttributeChange({
            type: 'updateAttribute',
            key: 'isRemote',
            value: cachedValue.toString(),
          });
          return;
        }

        // Optimistically set to false immediately for smooth UX
        // This shows delivery options without waiting for API
        // await applyAttributeChange({
        //   type: 'updateAttribute',
        //   key: 'isRemote',
        //   value: 'false',
        // });

        // Calculate subtotal
        const subtotal = lines.reduce((sum, l) => sum + Number(l.cost.totalAmount.amount), 0);
        const currencyCode = api.localization.currency.current.isoCode;

        // Build the comprehensive request body
        const body = {
          // Shop & Session Info
          shop: shop.myshopifyDomain,
          
          // Customer Info
          email: email || "",
          customer: customer ? {
            id: customer.id,
            firstName: customer.firstName || "",
            lastName: customer.lastName || "",
            email: customer.email || "",
            phone: customer.phone || "",
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
          
          // Localization & Currency
          currencyCode,
          language: api.localization.language.current.isoCode,
          
          // Store Info
          storeName: shop.name,
        };

        const response = await fetch(`https://shopify-app-dista-checkout.dista.care/api/set-cart-attribute`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

        const data = await response.json();
        const isRemote = data?.isRemote || false;

        // Cache the result
        remoteCache.set(cacheKey, isRemote);

        // Always update the attribute with the actual result
        await applyAttributeChange({
          type: 'updateAttribute',
          key: 'isRemote',
          value: isRemote.toString(),
        });
      } catch (error) {
        console.error('Error checking remote area:', error);
        // Keep the optimistic false value on error
      }
    }

    checkRemoteArea();
  }, [address?.zip, address?.countryCode]);

  // This component doesn't render anything visible
  return null;
}
