/** @jsxImportSource preact */
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { useLanguage, useLocalizationCountry, useShop } from "@shopify/ui-extensions/customer-account/preact";

export default function extension() {
  render(<ScratchRewards />, document.body);
}

const APP_URL = "https://shopify-app-dista-checkout.dista.care";

function ScratchRewards() {
  const shop = useShop();
  const country = useLocalizationCountry();
  const language = useLanguage();
  const [rewards, setRewards] = useState([]);
  const [status, setStatus] = useState("Loading your scratch rewards...");
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const jwt = await shopify.sessionToken.get();
        const response = await fetch(`${APP_URL}/api/scratch/rewards`, {
          headers: { Authorization: `Bearer ${jwt}` },
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to load rewards");
        if (!cancelled) {
          setRewards(data.rewards || []);
          setStatus(null);
        }
      } catch (error) {
        console.error("[scratch] account rewards lookup failed", error);
        if (!cancelled) setStatus("Your rewards could not be loaded. Please try again.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (status) return <s-text>{status}</s-text>;
  if (!rewards.length) return <s-text>No scratch rewards yet. Check back after your next order.</s-text>;
  const groups = [
    ["issued", "Available to scratch"],
    ["revealed", "Revealed rewards"],
    ["expired", "Expired rewards"],
    ["void", "Voided rewards"],
  ];

  return (
    <s-banner heading="🎉 Scratch & win rewards" tone="success">
      <s-stack gap="base">
      {groups.map(([state, heading]) => {
        const items = rewards.filter((reward) => reward.state === state);
        if (!items.length) return null;
        return (
          <s-stack key={state} gap="small">
            <s-text>{heading} ({items.length})</s-text>
            {items.map((reward) => (
              <s-box key={reward.token} background="subdued" border="base" borderRadius="large" padding="base">
                <s-stack gap="small">
                  <s-text>
                    {reward.orderName ? `${reward.orderName}: ` : ""}
                    {reward.state === "revealed"
                      ? reward.label || "Reward revealed"
                      : reward.state === "expired"
                        ? reward.label || "Reward expired"
                        : state === "issued"
                          ? "Scratch card available"
                          : "Reward voided"}
                  </s-text>
                  {reward.state === "revealed" && reward.code ? (
                    <s-stack gap="small">
                      <s-text>Coupon: {reward.code}</s-text>
                      <s-link
                        href={`${storefrontOrigin || ""}${marketPath}/discount/${encodeURIComponent(reward.code)}?redirect=/cart`}
                      >
                        Apply Now
                      </s-link>
                    </s-stack>
                  ) : reward.state === "issued" ? (
                    <s-link href={`${storefrontOrigin || ""}${marketPath}/apps/scratch/${reward.token}`}>
                      Scratch to reveal
                    </s-link>
                  ) : reward.state === "expired" ? (
                    <s-text>Expired on {new Date(reward.expiresAt).toLocaleString()}</s-text>
                  ) : null}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        );
      })}
      </s-stack>
    </s-banner>
  );
}
