import {useEffect, useRef} from 'preact/hooks';
import '@shopify/ui-extensions/preact';
import {
  useDeliveryGroups,
  useDeliveryGroup,
  useApplyAttributeChange,
  useInstructions
} from '@shopify/ui-extensions/checkout/preact';
// Removed @shopify/ui-extensions-react/checkout import and related components
import {render} from 'preact';


export default function extension() {
  render(<Extension />, document.body);
}

function Extension() {
  const deliveryGroups = useDeliveryGroups();
  const applyAttributeChange = useApplyAttributeChange();
  const instructions = useInstructions();

  // Track the last applied option so we don't spam updates
  // Correctly type the ref for lastAppliedHandle
  const lastAppliedHandle = useRef(null);

  // If no delivery groups, don't render UI, but still run effect to try to set attribute when available
  let selectedDeliveryOption = null;
  if (deliveryGroups && deliveryGroups.length > 0) {
    const firstGroup = deliveryGroups[0];
    const deliveryGroup = useDeliveryGroup(firstGroup);
    selectedDeliveryOption = deliveryGroup?.selectedDeliveryOption;
  }

  useEffect(() => {
    // No option selected yet
    if (!selectedDeliveryOption) return;

    // Respect instructions: attributes might not be writable
    if (!instructions.attributes.canUpdateAttributes) {
      return;
    }

    // Avoid re-applying the same value
    if (lastAppliedHandle.current === selectedDeliveryOption.handle) {
      return;
    }
    lastAppliedHandle.current = selectedDeliveryOption.handle;

    // Extract the date range after 'Estimated Delivery:'
    function extractEstimatedDelivery(title) {
      const match = title.match(/Estimated Delivery:\s*([A-Za-z]+\s\d{1,2}\s*-\s*[A-Za-z]*\s*\d{1,2})/);
      return match ? match[1].trim() : null;
    }

    (async () => {
      const estimatedDelivery = extractEstimatedDelivery(selectedDeliveryOption.title);
      const result = await applyAttributeChange({
        type: 'updateAttribute',
        key: 'estimated_delivery_date',
        value: estimatedDelivery || '',
      });

      // Optional: handle errors (e.g., accelerated checkout)
      if (result.type === 'error') {
        console.error('Failed to update cart attribute:', result.message);
      }
    })();
  }, [selectedDeliveryOption, instructions, applyAttributeChange]);

  // no UI to render, this extension only syncs the selected delivery option to a cart attribute

  return null;
}