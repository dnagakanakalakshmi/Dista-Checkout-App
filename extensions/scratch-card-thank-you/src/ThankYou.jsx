/** @jsxImportSource preact */
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  useLanguage,
  useLocalizationCountry,
  useShop,
} from "@shopify/ui-extensions/checkout/preact";

export default function extension() {
  render(<ScratchThankYou />, document.body);
}

const APP_URL = "https://dista-checkout-app.onrender.com";
const BANNER_IMAGE = `${APP_URL}/api/scratch/banner?v=2`;

function readOrderId() {
  const confirmation = shopify.orderConfirmation?.value || shopify.orderConfirmation?.current;
  return confirmation?.order?.id || confirmation?.id || null;
}

function ScratchThankYou() {
  const shop = useShop();
  const country = useLocalizationCountry();
  const language = useLanguage();
  const [orderId, setOrderId] = useState(readOrderId());
  const [card, setCard] = useState(null);
  const [checkingEligibility, setCheckingEligibility] = useState(true);
  const storefrontOrigin =
    shop?.storefrontUrl || (shop?.myshopifyDomain ? `https://${shop.myshopifyDomain}` : "");
  const languageParts = language?.isoCode?.toLowerCase().split("-");
  const marketLocale =
    languageParts?.length > 1
      ? languageParts.join("-")
      : languageParts?.[0] && country?.isoCode
        ? `${languageParts[0]}-${country.isoCode.toLowerCase()}`
        : languageParts?.[0];
  const marketPath = marketLocale ? `/${marketLocale}` : "";
  const origin = storefrontOrigin.replace(/\/$/, "");
  const accountUrl = `${origin}/account?tab=scratchRewards`;

  useEffect(() => {
    const unsubscribe = shopify.orderConfirmation?.subscribe?.((value) => {
      const id = value?.order?.id || value?.id;
      if (id) setOrderId(id);
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    if (!orderId) {
      setCheckingEligibility(false);
      return;
    }
    let cancelled = false;
    (async () => {
      for (let attempt = 0; attempt < 3 && !cancelled; attempt += 1) {
        try {
          const jwt = await shopify.sessionToken.get();
          const response = await fetch(
            `${APP_URL}/api/scratch/status?orderId=${encodeURIComponent(orderId)}`,
            { headers: { Authorization: `Bearer ${jwt}` } },
          );
          if (!response.ok) throw new Error(`Status lookup failed (${response.status})`);
          const data = await response.json();
          if (data.card?.token) {
            setCard(data.card);
            setCheckingEligibility(false);
            return;
          }
        } catch (error) {
          console.error("[scratch] status lookup failed", error);
          if (!cancelled) setCheckingEligibility(false);
          return;
        }
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 250 : 500));
        }
      }
      if (!cancelled) setCheckingEligibility(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  if (!card?.token) {
    if (!checkingEligibility) return null;
    return (
      <s-box
        inlineSize="100%"
        background="subdued"
        borderRadius="base"
        padding="base"
      >
        <s-skeleton-paragraph content="Checking if a scratch card is available" />
      </s-box>
    );
  }

  return (
    <s-clickable
      href={accountUrl}
      inlineSize="100%"
      blockSize="auto"
      padding="none"
      border="none"
      borderRadius="none"
      background="transparent"
      accessibilityLabel="Go to your scratch cards"
    >
      <s-image
        src={BANNER_IMAGE}
        alt="You've unlocked a surprise. Visit your account to scratch your reward."
        aspectRatio="1024/267"
        objectFit="cover"
        borderRadius="base"
        inlineSize="fill"
        loading="eager"
      />
    </s-clickable>
  );
}