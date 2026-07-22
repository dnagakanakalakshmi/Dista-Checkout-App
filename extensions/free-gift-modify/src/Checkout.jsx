import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

const GIFT_VARIANT_ID = 'gid://shopify/ProductVariant/48343224385765'; // hardcode for now
const THRESHOLD = 1000;

const GIFT_CAMPAIGN = {
  logic: 'OR', // 'AND' | 'OR' — how productType/collection/tag results combine
  conditions: {
    productTypes: ['Hoodies', 'T-Shirts'],
    collectionIds: ['gid://shopify/Collection/111111111'],
    tags: ['sale', 'clearance'],
  },
  giftVariantIds: ['gid://shopify/ProductVariant/48343224385765'], // supports multiple gift products
};

export default function extension() {
  render(<FreeGift />, document.body);
}

function FreeGift() {
    console.log('helllooooo')
  const subtotal = shopify.cost.subtotalAmount.value;
  const lines = shopify.lines.value;
  const busy = useRef(false);

  const giftLine = lines.find(
    (line) =>
    line.merchandise?.id === GIFT_VARIANT_ID &&
    line.attributes?.some((a) => a.key === '_auto_gift' && a.value === 'true'),
  );

  useEffect(() => {
    if (busy.current) return;
    const qualifies = Number(subtotal?.amount ?? 0) >= THRESHOLD;

    (async () => {
      busy.current = true;
      try {
        if (qualifies && !giftLine) {
          await shopify.applyCartLinesChange({
            type: 'addCartLine',
            merchandiseId: GIFT_VARIANT_ID,
            quantity: 1,
            attributes: [{ key: '_auto_gift', value: 'true' }],
          });
        } else if (!qualifies && giftLine) {
          await shopify.applyCartLinesChange({
            type: 'removeCartLine',
            id: giftLine.id,
            quantity: giftLine.quantity,
          });
        }
      } finally {
        busy.current = false;
      }
    })();
  }, [subtotal?.amount, giftLine?.id]);

  return null; // pure logic — swap in a <s-banner> if you want to tell the customer they got a gift
}