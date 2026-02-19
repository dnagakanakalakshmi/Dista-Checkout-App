import {useEffect, useRef} from 'preact/hooks';
import '@shopify/ui-extensions/preact';
import {
  useDeliveryGroups,
  useDeliveryGroup,
  useApplyAttributeChange,
  useAttributeValues,
} from '@shopify/ui-extensions/checkout/preact';
// Removed @shopify/ui-extensions-react/checkout import and related components
import {render} from 'preact';


export default function extension() {
  render(<Extension />, document.body);
}

function Extension() {
  // 1. Read delivery groups and get the first delivery group
  const deliveryGroups = useDeliveryGroups();
  const firstGroup = deliveryGroups[0];
  const group = useDeliveryGroup(firstGroup);

  // 2. Read existing attribute value from checkout
  const [estimatedDeliveryAttr] = useAttributeValues([
    'estimated_delivery_date',
  ]);

  // 3. Writer for attributes
  const applyAttributeChange = useApplyAttributeChange();

  // 4. Current selected delivery option handle
  const selectedHandle = group?.selectedDeliveryOption?.handle;
  const selectedTitle = group?.selectedDeliveryOption?.title;

  useEffect(() => {

    function extractEstimatedDelivery(title) {
      const match = title.match(/Estimated Delivery:\s*([A-Za-z]+\s\d{1,2}\s*-\s*[A-Za-z]*\s*\d{1,2})/);
      return match ? match[1].trim() : null;
    }

    // No selected option yet → nothing to sync
    if (!selectedHandle) return;

    const estimatedDelivery = extractEstimatedDelivery(group?.selectedDeliveryOption?.title);

    // Attribute already matches selected handle → no update needed
    if (estimatedDeliveryAttr === estimatedDelivery) return;

    // Only now we actually write to attributes
    (async () => {
      const result = await applyAttributeChange({
        type: 'updateAttribute',
        key: 'estimated_delivery_date',
        value: estimatedDelivery,
      });

      if (result.type === 'error') {
        console.error(result.message);
      }
    })();
  }, [selectedTitle, selectedHandle, estimatedDeliveryAttr, applyAttributeChange]);

  return null;
}