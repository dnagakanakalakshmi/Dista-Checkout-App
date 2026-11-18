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

const APP_URL = "https://noticed-always-foods-blend.trycloudflare.com";
const MODAL_ID = "scratch-card-thank-you-modal";
const COUPON_ID = "scratch-thank-you-coupon";
const BANNER_IMAGE = `${APP_URL}/api/scratch/banner`;
const CONTINUE_SHOPPING_IMAGE = `${APP_URL}/scratch-continue-shopping-compact.svg`;
// Only used to pick the banner height; the width itself is 100% of the column.
const BANNER_WIDTH_DESKTOP = 500;
const BANNER_ASSUMED_MOBILE_WIDTH = 340;

function readOrderId() {
  const confirmation = shopify.orderConfirmation?.value || shopify.orderConfirmation?.current;
  return confirmation?.order?.id || confirmation?.id || null;
}

// Reads the real pixel width/height from PNG or JPEG bytes.
function readImageSize(bytes) {
  // PNG
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    return { w: view.getUint32(16), h: view.getUint32(20) };
  }
  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i < bytes.length - 9) {
      if (bytes[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = bytes[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      const isSOF =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8] };
      }
      i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
    }
  }
  return null;
}

function ScratchThankYou() {
  const shop = useShop();
  const country = useLocalizationCountry();
  const language = useLanguage();
  const [orderId, setOrderId] = useState(readOrderId());
  const [card, setCard] = useState(null);
  const [checkingEligibility, setCheckingEligibility] = useState(true);
  const [status, setStatus] = useState(null);
  const [revealing, setRevealing] = useState(false);
  const [reward, setReward] = useState(null);
  const [copied, setCopied] = useState(false);
  const [bannerSize, setBannerSize] = useState({ w: 1050, h: 420 });
  const [bannerLoaded, setBannerLoaded] = useState(false);
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
  const storefrontUrl = origin ? `${origin}${marketPath}` : null;

  useEffect(() => {
    const unsubscribe = shopify.orderConfirmation?.subscribe?.((value) => {
      const id = value?.order?.id || value?.id;
      if (id) setOrderId(id);
    });
    return () => unsubscribe?.();
  }, []);

  // Read the banner's real dimensions; when this finishes, the skeleton is replaced by the banner.
  useEffect(() => {
    if (!card?.token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(BANNER_IMAGE);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const size = readImageSize(bytes);
        if (size?.w && size?.h && !cancelled) setBannerSize(size);
      } catch (error) {
        console.error("[scratch-thank-you] banner size lookup failed", error);
      } finally {
        if (!cancelled) setBannerLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [card?.token]);

  useEffect(() => {
    if (!orderId) {
      setStatus("Your order is still loading. Please refresh this page.");
      setCheckingEligibility(false);
      return;
    }
    let cancelled = false;
    (async () => {
      for (let attempt = 0; attempt < 15 && !cancelled; attempt += 1) {
        try {
          const jwt = await shopify.sessionToken.get();
          const response = await fetch(
            `${APP_URL}/api/scratch/status?orderId=${encodeURIComponent(orderId)}`,
            { headers: { Authorization: `Bearer ${jwt}` } },
          );
          const data = await response.json();
          if (data.card?.token) {
            setCard(data.card);
            if (data.card.state === "revealed") setReward(data.card);
            setStatus(null);
            setCheckingEligibility(false);
            return;
          }
          if (data.eligibilityChecked) {
            setStatus("No scratch card is available for this order.");
            setCheckingEligibility(false);
            return;
          }
        } catch (error) {
          console.error("[scratch] status lookup failed", error);
          if (!cancelled) {
            setStatus("Unable to check reward eligibility. Please refresh this page.");
            setCheckingEligibility(false);
          }
          return;
        }
        if (attempt < 14) {
          await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 150 : 350));
        }
      }
      if (!cancelled) {
        setStatus("No scratch card is available for this order.");
        setCheckingEligibility(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  async function reveal() {
    if (!card?.token || revealing || reward?.state === "revealed") return;
    setReward(null);
    setRevealing(true);
    try {
      const jwt = await shopify.sessionToken.get();
      const response = await fetch(`${APP_URL}/api/scratch/reveal`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: card.token }),
      });
      const data = await response.json();
      if (!response.ok || data.state === "error") throw new Error("Reveal failed");
      setReward(data);
    } catch (error) {
      console.error("[scratch] reveal failed", error);
      setReward({ state: "error" });
    } finally {
      setRevealing(false);
    }
  }

  const revealed = reward?.state === "revealed";
  const failed = reward?.state === "error";
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(globalThis.navigator?.userAgent || "");
  const heightBasis = isMobile ? BANNER_ASSUMED_MOBILE_WIDTH : BANNER_WIDTH_DESKTOP;
  const bannerHeight = Math.round((heightBasis * bannerSize.h) / bannerSize.w);

  if (!card?.token) {
    if (!checkingEligibility) return null;
    return (
      <s-box
        inlineSize="100%"
        blockSize={`${bannerHeight}px`}
        background="subdued"
        borderRadius="base"
        padding="base"
      >
        <s-skeleton-paragraph content="Checking reward eligibility" />
      </s-box>
    );
  }

  return (
    <>
      {bannerLoaded ? (
        <s-clickable
          onClick={reveal}
          commandFor={MODAL_ID}
          command="--show"
          inlineSize="100%"
          blockSize={`${bannerHeight}px`}
          padding="none"
          border="none"
          borderRadius="none"
          background="transparent"
          accessibilityLabel={revealed ? "View your reward" : "Tap to reveal your reward"}
        >
          <s-image
            src={BANNER_IMAGE}
            alt="You've unlocked a surprise. A guaranteed reward is waiting for you. Tap to reveal."
            aspectRatio={`${bannerSize.w}/${bannerSize.h}`}
            objectFit="cover"
            borderRadius="base"
            inlineSize="fill"
            loading="eager"
          />
        </s-clickable>
      ) : (
        <s-box
          inlineSize="100%"
          blockSize={`${bannerHeight}px`}
          background="subdued"
          borderRadius="base"
          padding="base"
        >
          <s-skeleton-paragraph content="Loading your reward" />
        </s-box>
      )}
      <s-modal
        id={MODAL_ID}
        heading={revealed ? "Your reward is unlocked" : "You've unlocked a surprise"}
        size="base"
      >
        {revealed ? (
          <Reward
            reward={reward}
            copied={copied}
            onCopy={() => setCopied(true)}
            storefrontUrl={storefrontUrl}
            couponId={COUPON_ID}
          />
        ) : failed ? (
          <s-stack gap="base">
            <s-text>We couldn't reveal your reward. Please try again.</s-text>
            <s-button variant="primary" onClick={reveal} disabled={revealing}>
              Try again
            </s-button>
          </s-stack>
        ) : !card ? (
          status ? (
            <s-text>{status}</s-text>
          ) : (
            <s-skeleton-paragraph content="Loading your reward" />
          )
        ) : reward ? (
          <s-stack gap="base">
            <s-text>
              Your scratch card is {reward.state}
              {reward.reason || reward.message ? ` (${reward.reason || reward.message})` : ""}.
            </s-text>
            <s-button variant="primary" onClick={reveal} disabled={revealing}>
              Try again
            </s-button>
          </s-stack>
        ) : revealing ? (
          <s-stack gap="small" alignItems="center">
            <s-spinner size="base" accessibilityLabel="Revealing your reward" />
            <s-text color="subdued">Revealing your reward...</s-text>
          </s-stack>
        ) : (
          <s-text>Your reward is ready to reveal.</s-text>
        )}
      </s-modal>
    </>
  );
}

function Reward({ reward, copied, onCopy, storefrontUrl, couponId }) {
  const expiry = reward.expiresAt
    ? new Date(reward.expiresAt).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      })
    : null;

  return (
    <s-stack gap="base">
      {reward.code ? (
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-box
            background="subdued"
            border="base"
            borderRadius="base"
            padding="small base"
            inlineSize="fill"
          >
            <s-clipboard-item id={couponId} text={reward.code} onCopy={onCopy} />
            <s-text type="strong">{reward.code}</s-text>
          </s-box>
          <s-button variant="secondary" commandFor={couponId} command="--copy">
            {copied ? "Copied!" : "Copy code"}
          </s-button>
        </s-stack>
      ) : (
        <s-text>This reward is applied automatically per the promotion rules.</s-text>
      )}

      {expiry ? (
        <s-stack direction="inline" gap="small-200">
          <s-text type="strong">Valid until:</s-text>
          <s-text>{expiry} until your next order</s-text>
        </s-stack>
      ) : null}

      {storefrontUrl ? (
        <s-clickable
          href={storefrontUrl}
          inlineSize="fill"
          padding="none"
          border="none"
          borderRadius="none"
          background="transparent"
          accessibilityLabel="Continue Shopping"
        >
          <s-image
            src={CONTINUE_SHOPPING_IMAGE}
            alt=""
            aspectRatio="50/3"
            objectFit="cover"
            inlineSize="fill"
          />
        </s-clickable>
      ) : null}
    </s-stack>
  );
}