import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useNavigate } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { authenticate } from "../shopify.server";
import {
  getFreeGiftConfig,
  saveFreeGiftConfig,
  ensureFreeGiftAutomaticDiscount,
} from "../models/freeGiftCampaigns.server";
import { json } from "@remix-run/node";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const { config, discountId } = await getFreeGiftConfig(admin);
  return { config, discountId };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const discountId = formData.get("discountId") || "";

  const { config: currentConfig } = await getFreeGiftConfig(admin);
  let nextConfig;

  if (intent === "delete-campaign") {
    const campaignId = formData.get("campaignId");
    nextConfig = {
      ...currentConfig,
      campaigns: currentConfig.campaigns.filter((c) => c.id !== campaignId),
    };
  } else if (intent === "save-settings") {
    let notification;
    let channelSettings;
    try {
      notification = JSON.parse(formData.get("notification") || "{}");
      channelSettings = JSON.parse(formData.get("channelSettings") || "{}");
    } catch {
      return json({ ok: false, errors: ["Invalid settings submitted"] }, { status: 400 });
    }
    nextConfig = { ...currentConfig, notification, channelSettings };
  } else {
    return json({ ok: false, errors: ["Unknown action"] }, { status: 400 });
  }

  try {
    const savedConfig = await saveFreeGiftConfig(admin, nextConfig, discountId);
    const { discountId: newDiscountId, errors } = await ensureFreeGiftAutomaticDiscount(
      admin,
      discountId,
      savedConfig,
    );
    if (newDiscountId && newDiscountId !== discountId) {
      await saveFreeGiftConfig(admin, savedConfig, newDiscountId);
    }
    if (errors.length) {
      return json({ ok: false, errors });
    }
    return json({ ok: true, config: savedConfig, discountId: newDiscountId, errors: [] });
  } catch (error) {
    console.error("Failed to save free gift campaigns:", error);
    return json({ ok: false, errors: [error.message || "Failed to save"] }, { status: 500 });
  }
};

function formatSubtotalRange(campaign) {
  const hasMin =
    campaign.subtotalThreshold !== null &&
    campaign.subtotalThreshold !== undefined &&
    campaign.subtotalThreshold !== "";
  const hasMax =
    campaign.subtotalMax !== null &&
    campaign.subtotalMax !== undefined &&
    campaign.subtotalMax !== "";

  if (!hasMin && !hasMax) return "No minimum";
  if (hasMin && hasMax) return `$${campaign.subtotalThreshold} – $${campaign.subtotalMax}`;
  if (hasMin) return `$${campaign.subtotalThreshold}+`;
  return `Up to $${campaign.subtotalMax}`;
}

export default function FreeGiftCampaigns() {
  const { config, discountId } = useLoaderData();
  const [campaigns, setCampaigns] = useState(config.campaigns || []);
  const [campaignToDelete, setCampaignToDelete] = useState(null);
  const [notification, setNotification] = useState(
    config.notification || { enabled: false, title: "You've unlocked free gifts!" },
  );
  const [channelSettings, setChannelSettings] = useState(
    config.channelSettings || { appbrewEnabled: false },
  );
  const settingsFetcher = useFetcher();
  const deleteFetcher = useFetcher();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const isSavingSettings = settingsFetcher.state !== "idle";
  const latestDiscountId = settingsFetcher.data?.discountId || deleteFetcher.data?.discountId || discountId || "";

  useEffect(() => {
    if (settingsFetcher.state !== "idle" || !settingsFetcher.data) return;
    if (settingsFetcher.data.ok) {
      shopify.toast.show("Settings saved");
      setNotification((current) => settingsFetcher.data.config?.notification || current);
      setChannelSettings((current) => settingsFetcher.data.config?.channelSettings || current);
    } else if (settingsFetcher.data.errors?.length) {
      shopify.toast.show(settingsFetcher.data.errors[0], { isError: true, tone: "critical" });
    }
  }, [settingsFetcher.state, settingsFetcher.data, shopify]);

  useEffect(() => {
    if (deleteFetcher.state !== "idle" || !deleteFetcher.data) return;
    if (deleteFetcher.data.ok) {
      shopify.toast.show("Campaign deleted");
      setCampaigns(deleteFetcher.data.config?.campaigns || []);
      setCampaignToDelete(null);
      document.getElementById("delete-free-gift-campaign-modal")?.hideOverlay();
    } else if (deleteFetcher.data.errors?.length) {
      shopify.toast.show(deleteFetcher.data.errors[0], { isError: true, tone: "critical" });
    }
  }, [deleteFetcher.state, deleteFetcher.data, shopify]);

  const requestDeleteCampaign = (campaign) => {
    setCampaignToDelete(campaign);
    document.getElementById("delete-free-gift-campaign-modal")?.showOverlay();
  };

  const confirmDeleteCampaign = () => {
    if (!campaignToDelete) return;
    deleteFetcher.submit(
      {
        intent: "delete-campaign",
        campaignId: campaignToDelete.id,
        discountId: latestDiscountId,
      },
      { method: "post" },
    );
  };

  const saveSettings = () => {
    settingsFetcher.submit(
      {
        intent: "save-settings",
        discountId: latestDiscountId,
        notification: JSON.stringify(notification),
        channelSettings: JSON.stringify(channelSettings),
      },
      { method: "post" },
    );
  };

  return (
    <s-page heading="Free Gift Campaigns">
      <s-section>
        <s-stack gap="base">
          <s-text>
            Configure automatic free gifts using subtotal threshold plus Product Type,
            Product Collection, and Product Tags.
          </s-text>

          {campaigns.length === 0 ? (
            <s-stack gap="base">
              <s-banner heading="No free gift campaigns">
                <s-text>Create a campaign to start adding eligible gifts automatically.</s-text>
              </s-banner>
              <s-button variant="primary" onClick={() => navigate("/app/free-gift-campaigns/new")}>
                Add campaign
              </s-button>
            </s-stack>
          ) : (
            <s-stack gap="base">
              <s-table>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Title</s-table-header>
                  <s-table-header listSlot="inline">Status</s-table-header>
                  <s-table-header listSlot="labeled">Subtotal range</s-table-header>
                  <s-table-header listSlot="labeled" format="numeric">Gifts</s-table-header>
                  <s-table-header listSlot="secondary">Actions</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {campaigns.map((campaign) => (
                    <s-table-row key={campaign.id}>
                      <s-table-cell>{campaign.title}</s-table-cell>
                      <s-table-cell>
                        <s-badge tone={campaign.enabled ? "success" : "neutral"}>
                          {campaign.enabled ? "Enabled" : "Disabled"}
                        </s-badge>
                      </s-table-cell>
                      <s-table-cell>{formatSubtotalRange(campaign)}</s-table-cell>
                      <s-table-cell>
                        {campaign.giftProducts?.length || campaign.giftVariantIds?.length || 0}
                      </s-table-cell>
                      <s-table-cell>
                        <s-stack direction="inline" gap="tight">
                          <s-button
                            variant="secondary"
                            onClick={() => navigate(`/app/free-gift-campaigns/${campaign.id}`)}
                          >
                            Edit
                          </s-button>
                          <s-button variant="secondary" tone="critical" onClick={() => requestDeleteCampaign(campaign)}>
                            Delete
                          </s-button>
                        </s-stack>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
              <s-button variant="primary" onClick={() => navigate("/app/free-gift-campaigns/new")}>
                Add campaign
              </s-button>
            </s-stack>
          )}

          <s-card>
            <s-stack gap="base">
              <s-checkbox
                label="Enable free gifts on Appbrew checkout"
                checked={channelSettings.appbrewEnabled}
                onChange={(event) =>
                  setChannelSettings((c) => ({ ...c, appbrewEnabled: event.target.checked }))
                }
              />
              <s-text tone="subdued">
                When disabled, free gift campaigns won't apply on the Appbrew sales
                channel, and any gift already in the cart will be removed at checkout.
              </s-text>
            </s-stack>
          </s-card>

          <s-card>
            <s-stack gap="base">
              <s-checkbox
                label="Show a notification when the gift is added to the cart"
                checked={notification.enabled}
                onChange={(event) => setNotification((n) => ({ ...n, enabled: event.target.checked }))}
              />
              {notification.enabled && (
                <s-text-field
                  label="Title"
                  value={notification.title}
                  onChange={(event) => setNotification((n) => ({ ...n, title: event.target.value }))}
                />
              )}
            </s-stack>
          </s-card>

          <s-button
            variant="primary"
            onClick={saveSettings}
            disabled={isSavingSettings}
            {...(isSavingSettings ? { loading: true } : {})}
          >
            Save settings
          </s-button>
        </s-stack>
      </s-section>
      <s-modal id="delete-free-gift-campaign-modal" heading="Delete campaign?">
        <s-stack gap="base">
          <s-text>
            Delete {campaignToDelete?.title ? `"${campaignToDelete.title}"` : "this campaign"}?
          </s-text>
          <s-text tone="caution">This action cannot be undone.</s-text>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={deleteFetcher.state !== "idle"}
          onClick={confirmDeleteCampaign}
        >
          Delete campaign
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor="delete-free-gift-campaign-modal"
          command="--hide"
          disabled={deleteFetcher.state !== "idle"}
        >
          Cancel
        </s-button>
      </s-modal>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);