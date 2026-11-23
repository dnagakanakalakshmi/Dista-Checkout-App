/** @jsxImportSource preact */
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  useLocalizationCountry,
  useOrder,
  useShop,
  useLanguage,
} from "@shopify/ui-extensions/customer-account/preact";

export default function extension() {
  render(<ScratchOrderStatus />, document.body);
}

const APP_URL = "https://shopify-app-dista-checkout.dista.care";
const BANNER_IMAGE = `${APP_URL}/api/scratch/banner?v=2`;

function ScratchOrderStatus() {
  const order = useOrder();
  const shop = useShop();
  const country = useLocalizationCountry();
  const language = useLanguage();
  const orderId = order?.id;
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
  const accountUrl = `${origin}${marketPath}/account#scratch-cards`;

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
        inlineSize="fill"
        blockSize="200px"
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
      inlineSize="fill"
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
        inlineSize="fill"
        loading="eager"
      />
    </s-clickable>
  );
}