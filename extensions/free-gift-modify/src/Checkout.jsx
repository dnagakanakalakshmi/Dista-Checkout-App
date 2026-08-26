import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

const AUTO_GIFT_KEY = '_auto_gift';
const AUTO_GIFT_VALUE = 'true';
const API_URL = 'https://shopify-app-dista-checkout.dista.care/apps/free-gift-campaigns';

export default function extension() {
  render(<FreeGift />, document.body);
}

function FreeGift() {
  const shop = shopify.shop;
  const lines = shopify.lines.value;
  const subtotal = shopify.cost.subtotalAmount.value;
  const attributes = shopify.attributes.value;
  const busy = useRef(false);
  const pendingRerun = useRef(false);
  const [notice, setNotice] = useState(null);

  const cartFingerprint = useMemo(
    () =>
      lines
        .map((line) => [
          line.id,
          line.quantity,
          line.merchandise?.id,
          line.cost?.totalAmount?.amount,
          isAutoGiftLine(line) ? 'gift' : 'regular',
        ].join(':'))
        .join('|'),
    [lines],
  );

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    void syncGifts();
  }, [cartFingerprint, subtotal?.amount, shop.myshopifyDomain, attributes]); 

  const syncGifts = async () => {
    if (busy.current) {
      pendingRerun.current = true;
      return;
    }
    busy.current = true;
    pendingRerun.current = false;

    try {
      const currentLines = shopify.lines.value;
      const autoGiftLines = currentLines.filter(isAutoGiftLine);

      const qualifyingSubtotal = currentLines
        .filter((line) => !isAutoGiftLine(line))
        .reduce((sum, line) => sum + Number(line.cost?.totalAmount?.amount || 0), 0);

      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shop: shop.myshopifyDomain,
          subtotal: qualifyingSubtotal,
          lines: currentLines.map((line) => ({
            id: line.id,
            quantity: line.quantity,
            merchandiseId: line.merchandise?.id,
            attributes: line.attributes || [],
            lineSubtotal: Number(line.cost?.totalAmount?.amount || 0),
          })),
          cartAttributes: shopify.attributes.value, 
        }),
      });

      const data = await response.json();
      if (!data?.ok) return;

      const notification = data.notification || { enabled: false, title: '' };
      const giftsList = data.gifts || (data.giftVariantIds || []).map((id) => ({ variantId: id, campaignId: null }));
      const desiredGiftIds = giftsList.map((g) => g.variantId);

      let added = false;
      for (const line of autoGiftLines) {
        const variantId = line.merchandise?.id;
        const duplicate = autoGiftLines.filter((l) => l.merchandise?.id === variantId).indexOf(line) > 0;
        if (!desiredGiftIds.includes(variantId) || duplicate) {
          const removeResult = await shopify.applyCartLinesChange({
            type: 'removeCartLine',
            id: line.id,
            quantity: line.quantity,
          });


          if (removeResult?.type === 'error' || removeResult?.errors?.length) {
            console.error('Failed to remove auto-gift line:', variantId, removeResult?.errors);
          }
        }
      }

      const existingGiftIds = new Set(autoGiftLines.map((line) => line.merchandise?.id));
      for (const variantId of desiredGiftIds) {
        if (existingGiftIds.has(variantId)) continue;

        const result = await shopify.applyCartLinesChange({
          type: 'addCartLine',
          merchandiseId: variantId,
          quantity: 1,
          attributes: [
            { key: AUTO_GIFT_KEY, value: AUTO_GIFT_VALUE },
          ],
        });


        const addSucceeded =
          result &&
          result.type !== 'error' &&
          !result.errors?.length;

        if (addSucceeded) {
          added = true;
        }
      }

      if (added && notification.enabled) {
        setNotice(notification.title);
      }
    } catch (error) {
      console.error('Failed to sync free gifts:', error);
    } finally {
      busy.current = false;
      if (pendingRerun.current) {
        void syncGifts();
      }
    }
  };

  if (!notice) return null;
  return <s-banner tone="success">{notice}</s-banner>;
}

function isAutoGiftLine(line) {
  return line.attributes?.some((attribute) => attribute.key === AUTO_GIFT_KEY && attribute.value === AUTO_GIFT_VALUE);
}