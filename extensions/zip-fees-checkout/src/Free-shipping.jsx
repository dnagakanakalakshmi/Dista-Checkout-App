import { useEffect, useRef } from "react";
import {
	reactExtension,
	useAttributes,
	useApplyAttributeChange,
	useDeliveryGroups,
	useShippingAddress,
	useCartLines,
	useAttributeValues,
} from "@shopify/ui-extensions-react/checkout";

export default reactExtension("purchase.checkout.block.render", () => (
	<DeliveryGroups />
));

function normalizeAmount(value) {
	if (value == null) return null;
	if (typeof value === "string" || typeof value === "number") {
		return toStableNumberString(value);
	}

	if (typeof value === "object") {
		if ("amount" in value && value.amount != null)
			return toStableNumberString(value.amount);
		if ("value" in value && value.value != null)
			return toStableNumberString(value.value);
	}

	return null;
}

function toStableNumberString(value) {
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return String(numeric);
	return String(value);
}

function getAttributeValue(attributes, key) {
	const match = (attributes || []).find((attribute) => attribute?.key === key);
	return typeof match?.value === "string" ? match.value : "";
}

function buildStableDiscountedPricePayload(deliveryGroups) {
	const payload = (deliveryGroups || []).flatMap((group, groupIndex) =>
		(group.deliveryOptions || []).map((option) => ({
			groupIndex,
			handle: option.handle,
			costAfterDiscounts: normalizeAmount(option.costAfterDiscounts),
		}))
	);

	// Keep payload order deterministic so transform-driven reordering does not cause write loops.
	payload.sort((a, b) => {
		const groupDiff = a.groupIndex - b.groupIndex;
		if (groupDiff !== 0) return groupDiff;
		return String(a.handle).localeCompare(String(b.handle));
	});

	return payload;
}

function DeliveryGroups() {
	const deliveryGroups = useDeliveryGroups();
	console.log("Current delivery groups:", deliveryGroups);
	const ATTRIBUTE_KEY = 'free_shipping_delivery_meta';
	const [attrValue] = useAttributeValues([ATTRIBUTE_KEY]);
	const lastWritten = useRef("");
	const cartLines = useCartLines();
	const {discountCodes, shippingAddress} = shopify;
	console.log("DeliveryGroups component render – current attribute value:", attrValue);
	useEffect(() => {
		console.log('--- [DeliveryGroups effect] RUN START ---');
		console.log('[DeliveryGroups] attrValue from cart:', attrValue);
		console.log('[DeliveryGroups] lastWritten.current:', lastWritten.current);

		console.log('[DeliveryGroups] discountCodes.value:', discountCodes.value);
		console.log('[DeliveryGroups] cartLines.value:', cartLines.value);
		console.log('[DeliveryGroups] shippingAddress.value:', shippingAddress.value);
		if (!shopify.instructions.value.attributes.canUpdateAttributes) {
		console.log(
			'[DeliveryGroups] attributes cannot be updated in this checkout, skipping.',
		);
		console.log('--- [DeliveryGroups effect] RUN END (no update) ---');
		return;
		}
		console.log(
		'[DeliveryGroups] Building free shipping payload from current state…',
		);
		// Recompute only when discount-related inputs change
		const payload = buildFreeShippingPayloadFromCurrentState();
	    console.log('[DeliveryGroups] Computed payload:', payload);

		const nextValue = JSON.stringify(payload);
	    console.log('[DeliveryGroups] nextValue (JSON):', nextValue);

        if (nextValue === lastWritten.current) {
			console.log(
				'[DeliveryGroups] nextValue is identical to lastWritten.current; skipping applyAttributeChange.',
			);
			console.log('--- [DeliveryGroups effect] RUN END (no update) ---');
			return;
		}

		console.log(
		'[DeliveryGroups] nextValue differs from lastWritten.current; will call applyAttributeChange.',
		);
		lastWritten.current = nextValue;

		void shopify
		.applyAttributeChange({
			type: 'updateAttribute',
			key: ATTRIBUTE_KEY,
			value: nextValue,
		})
		.then((result) => {
			if (result.type === 'error') {
		          console.error(
					'[DeliveryGroups] Failed to write cart attribute:',
					result.message,
					result,
				);
			}
			else{
				          console.log(
						'[DeliveryGroups] applyAttributeChange success result:',
						result,
					);
			}
		});
	}, [
		attrValue,
		cartLines.value,
		shippingAddress.value,
		// Add any other signals you know affect shipping discounts
	]);
}

function buildFreeShippingPayloadFromCurrentState() {
  const {deliveryGroups} = shopify;
  const groups = deliveryGroups.value ?? [];

  console.log(
    '[DeliveryGroups] buildFreeShippingPayloadFromCurrentState – raw deliveryGroups.value:',
    groups,
  );

  const result = {
    version: 1,
    groups: groups.map((group) => {
      const freeOptions = group.deliveryOptions.filter((option) => {
        const amount = option.costAfterDiscounts?.amount ?? option.cost?.amount;
        const isFree = amount === 0;

        console.log(
          '[DeliveryGroups] Evaluating option for free shipping:',
          {
            groupId: group.id,
            handle: option.handle,
            title: option.title,
            amount,
            isFree,
          },
        );

        return isFree;
      });

      const freeOptionHandles = freeOptions.map((option) => option.handle);

      console.log(
        '[DeliveryGroups] Group freeOptionHandles:',
        group.id,
        freeOptionHandles,
      );

      return {
        deliveryGroupId: group.id,
        freeOptionHandles,
      };
    }),
  };

  console.log(
    '[DeliveryGroups] buildFreeShippingPayloadFromCurrentState – normalized payload:',
    result,
  );

  return result;
}

function DeliveryOptionDiscountedPricesAttribute() {
	console.log("Rendering DeliveryOptionDiscountedPricesAttribute component");
	const applyAttributeChange = useApplyAttributeChange();
	const attributes = useAttributes();
	const deliveryGroups = useDeliveryGroups();
	const lastWrittenValueRef = useRef("");
	const lastAttemptedValueRef = useRef("");
	const address = useShippingAddress();
	const cartLinesChange = useCartLines();

	useEffect(() => {
		let cancelled = false;

		async function syncDeliveryOptionDiscountedPrices() {
			const deliveryOptionDiscountedPrices =
				buildStableDiscountedPricePayload(deliveryGroups);
			const existingAttributeValue = getAttributeValue(
				attributes,
				"deliveryOptionDiscountedPrices"
			);

			const attributeValue = JSON.stringify(deliveryOptionDiscountedPrices);

			if (attributeValue === existingAttributeValue) {
				lastWrittenValueRef.current = attributeValue;
				lastAttemptedValueRef.current = attributeValue;
				return;
			}

			if (attributeValue === lastWrittenValueRef.current) return;
			if (attributeValue === lastAttemptedValueRef.current) return;

			lastAttemptedValueRef.current = attributeValue;
			console.log(
				"Syncing deliveryOptionDiscountedPrices attribute with value:",
				attributeValue
			);

			try {
				const result = await applyAttributeChange({
					type: "updateAttribute",
					key: "deliveryOptionDiscountedPrices",
					value: attributeValue,
				});

				if (!cancelled && result?.type !== "error") {
					lastWrittenValueRef.current = attributeValue;
				}
			} catch (error) {
				console.error("Failed to update deliveryOptionDiscountedPrices:", error);
			}
		}

		void syncDeliveryOptionDiscountedPrices();

		return () => {
			cancelled = true;
		};
	}, [address?.zip, address?.countryCode, address?.countryCode, cartLinesChange]);

	return null;
}
