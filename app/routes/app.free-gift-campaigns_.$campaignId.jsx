import { useState } from "react";
import { useFetcher, useLoaderData, useNavigate } from "@remix-run/react";
import { useAppBridge, TitleBar } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { authenticate } from "../shopify.server";
import {
  getFreeGiftConfig,
  saveFreeGiftConfig,
  ensureFreeGiftAutomaticDiscount,
  normalizeCampaign,
} from "../models/freeGiftCampaigns.server";
import { randomUUID } from "node:crypto";
import { json, redirect } from "@remix-run/node";

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const { config, discountId } = await getFreeGiftConfig(admin);

  if (params.campaignId === "new") {
    const campaign = normalizeCampaign({ id: randomUUID(), enabled: true });
    return { campaign, discountId, isNew: true };
  }

  const campaign = config.campaigns.find((c) => c.id === params.campaignId);
  if (!campaign) {
    throw new Response("Campaign not found", { status: 404 });
  }
  return { campaign, discountId, isNew: false };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const discountId = formData.get("discountId") || "";

  let campaign;
  try {
    campaign = normalizeCampaign(JSON.parse(formData.get("campaign") || "{}"));
  } catch {
    return json({ ok: false, errors: ["Invalid campaign data submitted"] }, { status: 400 });
  }

  const { config: currentConfig } = await getFreeGiftConfig(admin);
  const exists = currentConfig.campaigns.some((c) => c.id === campaign.id);
  const nextCampaigns = exists
    ? currentConfig.campaigns.map((c) => (c.id === campaign.id ? campaign : c))
    : [...currentConfig.campaigns, campaign];

  try {
    const savedConfig = await saveFreeGiftConfig(admin, { ...currentConfig, campaigns: nextCampaigns }, discountId);
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
    return redirect("/app/free-gift-campaigns");
  } catch (error) {
    console.error("Failed to save campaign:", error);
    return json({ ok: false, errors: [error.message || "Failed to save campaign"] }, { status: 500 });
  }
};

export default function FreeGiftCampaignForm() {
  const { campaign: initialCampaign, discountId, isNew } = useLoaderData();
  const [campaign, setCampaign] = useState(initialCampaign);
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const isSaving = fetcher.state !== "idle";

  const update = (patch) => setCampaign((c) => ({ ...c, ...patch }));
  const updateConditions = (patch) =>
    setCampaign((c) => ({ ...c, conditions: { ...c.conditions, ...patch } }));

  const pickGiftProducts = async () => {
    const selection = await shopify.resourcePicker({
      type: "product",
      multiple: false,
      selectionIds: campaign.giftProducts?.map((product) => ({ id: product.id })) || [],
    });
    if (!selection) return;

    const giftProducts = selection
      .map((product) => ({
        id: product.id,
        title: product.title || product.handle || "Gift product",
        variantId: product.variants?.[0]?.id || "",
      }))
      .filter((product) => product.variantId);

    update({ giftProducts, giftVariantIds: giftProducts.map((p) => p.variantId) });
  };

  const pickCollections = async () => {
    const selection = await shopify.resourcePicker({
      type: "collection",
      multiple: true,
      selectionIds: campaign.conditions.collections?.map((c) => ({ id: c.id })) || [],
    });
    if (!selection) return;

    const collections = selection.map((c) => ({ id: c.id, title: c.title || c.handle || "Collection" }));
    updateConditions({ collections, collectionIds: collections.map((c) => c.id) });
  };

  const save = () => {
    const payload = {
      ...campaign,
      subtotalThreshold:
        campaign.subtotalThreshold === "" || campaign.subtotalThreshold === null || campaign.subtotalThreshold === undefined
          ? null
          : Number(campaign.subtotalThreshold),
      giftVariantIds: campaign.giftProducts?.map((p) => p.variantId).filter(Boolean) || campaign.giftVariantIds || [],
      conditions: {
        ...campaign.conditions,
        collectionIds: campaign.conditions.collections?.map((c) => c.id) || campaign.conditions.collectionIds || [],
      },
    };
    fetcher.submit(
      { discountId: discountId || "", campaign: JSON.stringify(payload) },
      { method: "post" },
    );
  };

  return (
    <s-page heading={isNew ? "New Free Gift Campaign" : "Edit Free Gift Campaign"} backAction="/app/free-gift-campaigns">
      <TitleBar title={isNew ? "New Free Gift Campaign" : "Edit Free Gift Campaign"}>
        <button variant="breadcrumb" onClick={() => navigate("/app/free-gift-campaigns")}>
          Free Gift Campaigns
        </button>
      </TitleBar>
      <s-section>
        <s-stack gap="base">
          <s-button
            type="button"
            variant="tertiary"
            icon="arrow-left"
            onClick={() => navigate("/app/free-gift-campaigns")}
          >
            Back
          </s-button>
          {fetcher.data?.errors?.length > 0 && (
            <s-banner tone="critical" heading="Save issue">
              <s-text>{fetcher.data.errors.join("; ")}</s-text>
            </s-banner>
          )}

          <s-checkbox
            label="Enabled"
            checked={campaign.enabled}
            onChange={(event) => update({ enabled: event.target.checked })}
          />

          <s-text-field
            label="Campaign title"
            value={campaign.title}
            onChange={(event) => update({ title: event.target.value })}
          />

          <s-number-field
            label="Subtotal threshold"
            min={0}
            max={100000}
            step={1}
            value={campaign.subtotalThreshold ?? ""}
            placeholder="Leave blank for no subtotal requirement. Entering 0 will prevent this campaign from ever qualifying."
            onChange={(event) => update({ subtotalThreshold: event.target.value })}
          />

          <s-select
            label="Condition logic"
            value={campaign.logic}
            onChange={(event) => update({ logic: event.target.value })}
          >
            <s-option value="OR">Match any condition</s-option>
            <s-option value="AND">Match all configured conditions</s-option>
          </s-select>

          <s-stack direction="inline" gap="base">
            <s-box inlineSize="50%">
              <s-text-field
                label="Product types"
                value={(campaign.conditions.productTypes || []).join(", ")}
                placeholder="Hoodies, T-Shirts"
                helpText="Comma-separated product types."
                onChange={(event) => updateConditions({ productTypes: splitCsv(event.target.value) })}
              />
            </s-box>
            <s-box inlineSize="50%">
              <s-text-field
                label="Product tags"
                value={(campaign.conditions.tags || []).join(", ")}
                placeholder="sale, clearance"
                helpText="Comma-separated tags."
                onChange={(event) => updateConditions({ tags: splitCsv(event.target.value) })}
              />
            </s-box>
          </s-stack>

          <s-stack gap="tight">
            <s-text variant="bodyMd" fontWeight="medium">Eligible collections</s-text>
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-button type="button" variant="secondary" onClick={pickCollections}>
                Select collections
              </s-button>
              <s-text tone="subdued">
                {campaign.conditions.collections?.length
                  ? campaign.conditions.collections.map((c) => c.title).join(", ")
                  : "No collections selected"}
              </s-text>
            </s-stack>
          </s-stack>

          <s-stack gap="tight">
            <s-text variant="bodyMd" fontWeight="medium">Free gift products</s-text>
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-button type="button" variant="secondary" onClick={pickGiftProducts}>
                Select gift products
              </s-button>
              <s-text tone="subdued">
                {campaign.giftProducts?.length
                  ? campaign.giftProducts.map((p) => p.title).join(", ")
                  : "No gift products selected"}
              </s-text>
            </s-stack>
          </s-stack>

          <s-stack direction="inline" gap="base">
            <s-button type="button" variant="secondary" onClick={() => navigate("/app/free-gift-campaigns")}>
              Cancel
            </s-button>
            <s-button
              variant="primary"
              onClick={save}
              disabled={isSaving}
              {...(isSaving ? { loading: true } : {})}
            >
              Save campaign
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}

function splitCsv(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export const headers = (headersArgs) => boundary.headers(headersArgs);