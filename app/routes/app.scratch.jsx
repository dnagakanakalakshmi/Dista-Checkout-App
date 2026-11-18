import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { useEffect, useMemo, useState } from "react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  DataTable,
  FormLayout,
  InlineStack,
  Layout,
  Modal,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureScratchSetup } from "../models/scratch.server";

const types = ["PERCENT", "FIXED", "FREE_SHIPPING", "WALLET", "POINTS"];
const expiryUnits = ["HOURS", "DAYS", "WEEKS", "MONTHS"];
const emptyReward = {
  label: "",
  category: "Other Scratch Cards",
  description: "",
  imageUrl: "",
  imageFileId: "",
  collectionId: "",
  collectionHandle: "",
  collectionTitle: "",
  type: "PERCENT",
  value: "10",
  weight: "10",
  minOrderValue: "0",
  maxIssued: "",
  expiryValue: "48",
  expiryUnit: "HOURS",
  segmentIds: [],
  active: true,
};

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  await ensureScratchSetup(shop);
  const segmentsResponse = await admin.graphql(
    `#graphql
    query ScratchRewardSegments {
      shop {
        currencyCode
      }
      segments(first: 100) {
        nodes {
          id
          name
        }
      }
    }`,
  );
  const segmentsPayload = await segmentsResponse.json();
  if (segmentsPayload.errors?.length) {
    throw new Error(
      `Unable to load customer segments: ${segmentsPayload.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }
  if (!segmentsPayload.data?.segments?.nodes) {
    throw new Error("Unable to load customer segments.");
  }
  const currencyCode = segmentsPayload.data?.shop?.currencyCode;
  if (!currencyCode) {
    throw new Error("Unable to load the shop currency for scratch reward minimums.");
  }
  const now = new Date();
  const [rewardRecords, issued, revealed, expired, voided] = await Promise.all([
    db.rewardTemplate.findMany({ where: { shop }, orderBy: { label: "asc" } }),
    db.scratchCard.count({ where: { shop } }),
    db.scratchCard.count({
      where: {
        shop,
        status: "REVEALED",
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    }),
    db.scratchCard.count({
      where: {
        shop,
        OR: [
          { status: "EXPIRED" },
          { status: "REVEALED", expiresAt: { lte: now } },
        ],
      },
    }),
    db.scratchCard.count({ where: { shop, status: "VOID" } }),
  ]);
  return json({
    rewards: rewardRecords.filter((reward) => !reward.deletedAt),
    currencyCode,
    segments: segmentsPayload.data?.segments?.nodes || [],
    stats: { issued, revealed, expired, voided },
  });
};

async function lookupRewardImage(admin, fileId) {
  const response = await admin.graphql(
    `#graphql
    query ScratchRewardImage($id: ID!) {
      node(id: $id) {
        ... on MediaImage {
          id
          image {
            url
          }
        }
      }
    }`,
    { variables: { id: fileId } },
  );
  const payload = await response.json();
  if (payload.errors?.length) {
    console.error("[scratch] image lookup failed", payload.errors);
    return { ok: false, status: 502, error: "Unable to load the selected Shopify image." };
  }
  const image = payload.data?.node;
  if (image?.id !== fileId || typeof image?.image?.url !== "string") {
    return { ok: false, status: 404, error: "The selected file is not an available image." };
  }
  return { ok: true, imageFileId: image.id, imageUrl: image.image.url };
}

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const body = await request.json();
  if (body.intent === "resolveImageFile") {
    const fileId = typeof body.fileId === "string" ? body.fileId.trim() : "";
    if (!/^gid:\/\/shopify\/MediaImage\/\d+$/.test(fileId)) {
      return json({ ok: false, error: "Select a valid Shopify image." }, { status: 400 });
    }
    const image = await lookupRewardImage(admin, fileId);
    return json(image, { status: image.ok ? 200 : image.status });
  }
  if (body.intent === "delete") {
    const reward = await db.rewardTemplate.findFirst({
      where: { id: body.id, shop },
    });
    if (!reward || reward.deletedAt) {
      return json({ ok: false, error: "Reward not found." }, { status: 404 });
    }

    await db.rewardTemplate.update({
      where: { id: reward.id },
      data: { active: false, deletedAt: new Date() },
    });
    return json({
      ok: true,
      message: "Reward removed. Existing cards keep their reward history.",
    });
  } else if (body.intent === "saveReward") {
    const reward = body.reward;
    if (typeof reward.label !== "string" || !reward.label.trim()) {
      return json({ ok: false, error: "Reward label is required." }, { status: 400 });
    }
    const value = Number(reward.value);
    const weight = Number(reward.weight);
    const minOrderValue = Number(reward.minOrderValue);
    const expiryValue = Number(reward.expiryValue);
    const segmentIds = reward.segmentIds ?? [];
    const maxIssued =
      reward.maxIssued === "" || reward.maxIssued == null ? null : Number(reward.maxIssued);
    const category = typeof reward.category === "string" ? reward.category.trim() : "";
    const description = typeof reward.description === "string" ? reward.description.trim() : "";
    const imageFileId = typeof reward.imageFileId === "string" ? reward.imageFileId.trim() : "";
    let imageUrl = typeof reward.imageUrl === "string" ? reward.imageUrl.trim() : "";
    if (imageFileId) {
      if (!/^gid:\/\/shopify\/MediaImage\/\d+$/.test(imageFileId)) {
        return json({ ok: false, error: "Select a valid Shopify image." }, { status: 400 });
      }
      const image = await lookupRewardImage(admin, imageFileId);
      if (!image.ok) return json(image, { status: image.status });
      imageUrl = image.imageUrl;
    }
    const collectionId = typeof reward.collectionId === "string" ? reward.collectionId.trim() : "";
    const collectionHandle = typeof reward.collectionHandle === "string" ? reward.collectionHandle.trim() : "";
    const collectionTitle = typeof reward.collectionTitle === "string" ? reward.collectionTitle.trim() : "";
    const hasCollection = Boolean(collectionId || collectionHandle || collectionTitle);
    const validCollection =
      !hasCollection ||
      (/^gid:\/\/shopify\/Collection\/\d+$/.test(collectionId) &&
        /^[a-z0-9][a-z0-9-]*$/.test(collectionHandle) &&
        collectionTitle.length <= 255);
    let validImageUrl = !imageUrl;
    if (imageUrl) {
      try {
        validImageUrl = new URL(imageUrl).protocol === "https:";
      } catch {
        validImageUrl = false;
      }
    }
    if (
      typeof reward.category !== "string" ||
      category.length > 80 ||
      typeof reward.description !== "string" ||
      description.length > 140 ||
      typeof reward.imageUrl !== "string" ||
      imageUrl.length > 2048 ||
      !validImageUrl ||
      !validCollection ||
      !types.includes(reward.type) ||
      !Number.isFinite(value) ||
      value < 0 ||
      !Number.isInteger(weight) ||
      weight < 0 ||
      !Number.isFinite(minOrderValue) ||
      minOrderValue < 0 ||
      !Number.isInteger(expiryValue) ||
      expiryValue < 1 ||
      !expiryUnits.includes(reward.expiryUnit) ||
      !Array.isArray(segmentIds) ||
      segmentIds.some((segmentId) => typeof segmentId !== "string" || !segmentId) ||
      (maxIssued !== null && (!Number.isInteger(maxIssued) || maxIssued < 1))
    ) {
      return json({ ok: false, error: "Check reward values." }, { status: 400 });
    }
    const data = {
      shop,
      label: reward.label.trim(),
      category: category || null,
      description: description || null,
      imageUrl: imageUrl || null,
      collectionId: collectionId || null,
      collectionHandle: collectionHandle || null,
      collectionTitle: collectionTitle || null,
      type: reward.type,
      value,
      weight,
      minOrderValue,
      maxIssued,
      expiryValue,
      expiryUnit: reward.expiryUnit,
      segmentIds: [...new Set(segmentIds)],
      active: !!reward.active,
    };
    if (reward.id) {
      const existing = await db.rewardTemplate.findFirst({ where: { id: reward.id, shop } });
      if (!existing || existing.deletedAt) {
        return json({ ok: false, error: "Reward not found." }, { status: 404 });
      }
      if (data.maxIssued !== null && data.maxIssued < existing.issuedCount) {
        return json(
          { ok: false, error: "Max issued cannot be below rewards already issued." },
          { status: 400 },
        );
      }
      await db.rewardTemplate.update({ where: { id: reward.id }, data });
    } else await db.rewardTemplate.create({ data: { ...data, deletedAt: null } });
  } else {
    return json({ ok: false, error: "Unknown action" }, { status: 400 });
  }
  return json({ ok: true });
};

const unitLabel = (value, unit) => {
  const base = String(unit || "HOURS").toLowerCase();
  return `${value} ${Number(value) === 1 ? base.replace(/s$/, "") : base}`;
};

export default function ScratchAdmin() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const [draft, setDraft] = useState(null);
  const [deleteCandidate, setDeleteCandidate] = useState(null);
  const saving = fetcher.state !== "idle";
  const error = fetcher.data?.ok === false ? fetcher.data.error : null;
  const notice = fetcher.data?.ok ? fetcher.data.message : null;

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      setDraft(null);
    }
  }, [fetcher.data, fetcher.state]);

  const submit = (intent, payload) =>
    fetcher.submit(JSON.stringify({ intent, ...payload }), {
      method: "post",
      encType: "application/json",
    });

  const totalWeight = useMemo(
    () => data.rewards.filter((reward) => reward.active).reduce((sum, reward) => sum + reward.weight, 0),
    [data.rewards],
  );

  const rows = data.rewards.map((reward) => [
    reward.label,
    reward.category || "Other Scratch Cards",
    reward.type,
    String(reward.value),
    String(reward.minOrderValue),
    reward.segmentIds?.length
      ? reward.segmentIds
          .map((id) => data.segments.find((segment) => segment.id === id)?.name || id)
          .join(", ")
      : "All customers",
    unitLabel(reward.expiryValue ?? 48, reward.expiryUnit),
    `${reward.weight} / ${reward.active && totalWeight ? ((reward.weight / totalWeight) * 100).toFixed(1) : 0}%`,
    reward.active ? "Yes" : "No",
    <InlineStack key={reward.id} gap="200">
      <Button
        disabled={saving}
        onClick={() =>
          setDraft({
            ...reward,
            category: reward.category || "",
            description: reward.description || "",
            imageUrl: reward.imageUrl || "",
            imageFileId: reward.imageFileId || "",
            collectionId: reward.collectionId || "",
            collectionHandle: reward.collectionHandle || "",
            collectionTitle: reward.collectionTitle || "",
            maxIssued: reward.maxIssued ?? "",
            value: String(reward.value),
            weight: String(reward.weight),
            minOrderValue: String(reward.minOrderValue),
            expiryValue: String(reward.expiryValue ?? 48),
            expiryUnit: reward.expiryUnit || "HOURS",
          })
        }
      >
        Edit
      </Button>
      <Button tone="critical" disabled={saving} onClick={() => setDeleteCandidate(reward)}>
        Delete
      </Button>
    </InlineStack>,
  ]);

  return (
    <Page>
      <TitleBar title="Scratch Cards" />
      <BlockStack gap="400">
        <Banner tone="info">
          Cards are issued after a successful order, using only active rewards the order is eligible for. Add the
          scratch card blocks on the Thank you and Order status pages. To turn the feature off, deactivate all rewards.
        </Banner>
        {error ? <Banner tone="critical">{error}</Banner> : null}
        {notice ? <Banner tone="success">{notice}</Banner> : null}
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">
                    Rewards — what customers can win
                  </Text>
                  <Button disabled={saving} onClick={() => setDraft({ ...emptyReward })}>
                    Add reward
                  </Button>
                </InlineStack>
                <Text as="p" variant="bodyMd">
                  Each reward has its own rules. Weight sets its relative chance among eligible rewards—for example,
                  weight 20 is twice as likely as weight 10. Minimum order and Customer segments set eligibility,
                  Expiry sets how long it stays valid after it is revealed, Max issued limits a prize, and Active turns
                  it on or off.
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  The odds shown are a reference across all active rewards; actual odds vary based on order eligibility.
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Minimum order values are in your store currency ({data.currencyCode}). Shopify converts orders paid
                  in other currencies to your store currency before checking eligibility.
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Total cards: {data.stats.issued} · Revealed: {data.stats.revealed} · Expired: {data.stats.expired} ·
                  Voided: {data.stats.voided}
                </Text>
                {draft ? (
                  <RewardForm
                    reward={draft}
                    segments={data.segments}
                    currencyCode={data.currencyCode}
                    onChange={setDraft}
                    onSave={() => submit("saveReward", { reward: draft })}
                    onCancel={() => setDraft(null)}
                    saving={saving}
                  />
                ) : null}
                <DataTable
                columnContentTypes={["text", "text", "text", "numeric", "numeric", "text", "text", "text", "text", "text"]}
                headings={["Label", "Account category", "Type", "Value", `Min order (${data.currencyCode})`, "Customer segments", "Expiry", "Weight / active share", "Active", ""]}
                  rows={rows}
                />
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
      <Modal
        open={Boolean(deleteCandidate)}
        onClose={() => {
          if (!saving) setDeleteCandidate(null);
        }}
        title={`Delete ${deleteCandidate?.label || "reward"}?`}
        primaryAction={{
          content: "Delete reward",
          destructive: true,
          loading: saving,
          disabled: saving,
          onAction: () => {
            submit("delete", { id: deleteCandidate.id });
            setDeleteCandidate(null);
          },
        }}
        secondaryActions={[
          {
            content: "Cancel",
            disabled: saving,
            onAction: () => setDeleteCandidate(null),
          },
        ]}
      >
        <Modal.Section>
          <Text as="p">
            This reward will no longer be offered. Existing scratch cards keep their reward history and customer
            discounts are not removed.
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

function RewardForm({ reward, segments, currencyCode, onChange, onSave, onCancel, saving }) {
  const shopify = useAppBridge();
  const imageFetcher = useFetcher();
  const [pickingImage, setPickingImage] = useState(false);
  const set = (key, value) => onChange({ ...reward, [key]: value });
  useEffect(() => {
    if (!imageFetcher.data) return;
    if (imageFetcher.data.ok) {
      onChange((current) => ({
        ...current,
        imageFileId: imageFetcher.data.imageFileId,
        imageUrl: imageFetcher.data.imageUrl,
      }));
      return;
    }
    shopify.toast.show(imageFetcher.data.error || "Unable to load the selected Shopify image.", {
      isError: true,
      tone: "critical",
    });
  }, [imageFetcher.data, onChange, shopify]);

  const pickImage = async () => {
    setPickingImage(true);
    try {
      const activity = await shopify.intents?.invoke?.("pick:shopify/File", {
        data: {
          mediaTypes: ["MediaImage"],
          multiSelect: false,
          selectedFiles: reward.imageFileId ? [reward.imageFileId] : [],
        },
      });
      if (!activity?.complete) {
        throw new Error("Shopify's file picker is unavailable. Refresh the app and try again.");
      }
      const result = await activity.complete;
      if (result.code === "closed") return;
      if (result.code !== "ok") {
        throw new Error("Shopify could not return the selected image.");
      }
      const ids = result.data?.ids;
      if (!Array.isArray(ids) || typeof ids[0] !== "string") {
        throw new Error("Select an image from Shopify Files.");
      }
      imageFetcher.submit(JSON.stringify({ intent: "resolveImageFile", fileId: ids[0] }), {
        method: "post",
        encType: "application/json",
      });
    } catch (error) {
      console.error("[scratch] image picker failed", error);
      shopify.toast.show(error.message || "Unable to open Shopify's image picker.", {
        isError: true,
        tone: "critical",
      });
    } finally {
      setPickingImage(false);
    }
  };
  const pickCollection = async () => {
    const selection = await shopify.resourcePicker({
      type: "collection",
      multiple: false,
      selectionIds: reward.collectionId ? [{ id: reward.collectionId }] : [],
    });
    if (!selection) return;
    const collection = selection[0];
    if (!collection) return;
    onChange({
      ...reward,
      collectionId: collection.id || "",
      collectionHandle: collection.handle || "",
      collectionTitle: collection.title || collection.handle || "Collection",
    });
  };
  return (
    <Card>
      <BlockStack gap="300">
        <FormLayout>
          <TextField
            label="Label"
            value={reward.label}
            onChange={(value) => set("label", value)}
            autoComplete="off"
            required
            helpText="Required. Shown as the reward title to customers."
          />
          <TextField
            label="Account page category"
            value={reward.category ?? ""}
            onChange={(value) => set("category", value)}
            autoComplete="off"
            helpText="Optional. Rewards with the same category appear together. Clear this field to use the default category."
          />
          <TextField
            label="Account page description"
            value={reward.description || ""}
            onChange={(value) => set("description", value)}
            autoComplete="off"
            helpText="Optional subtitle shown below the offer label."
          />
          <Text as="h3" variant="headingSm">Reward image</Text>
          <Text as="p" variant="bodySm" tone="subdued">
            Optionally choose an image from your Shopify Files to show on the reward card.
          </Text>
          <InlineStack gap="200" blockAlign="center">
            <Button
              onClick={pickImage}
              loading={pickingImage || imageFetcher.state !== "idle"}
              disabled={saving || pickingImage || imageFetcher.state !== "idle"}
            >
              Choose image
            </Button>
            {reward.imageUrl ? (
              <>
                <img
                  src={reward.imageUrl}
                  alt="Selected reward"
                  style={{ width: 64, height: 64, objectFit: "contain" }}
                />
                <Button
                  variant="plain"
                  disabled={saving || pickingImage || imageFetcher.state !== "idle"}
                  onClick={() => onChange({ ...reward, imageFileId: "", imageUrl: "" })}
                >
                  Remove image
                </Button>
              </>
            ) : (
              <Text as="span" variant="bodySm" tone="subdued">No image selected</Text>
            )}
          </InlineStack>
          <Text as="h3" variant="headingSm">
            Buy Now destination
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            After applying the discount code, send customers to this collection. Leave it empty to send them to the
            storefront home page.
          </Text>
          <InlineStack gap="200" blockAlign="center">
            <Button onClick={pickCollection}>Select collection</Button>
            {reward.collectionTitle ? (
              <>
                <Text as="span" variant="bodySm">{reward.collectionTitle}</Text>
                <Button
                  variant="plain"
                  onClick={() =>
                    onChange({ ...reward, collectionId: "", collectionHandle: "", collectionTitle: "" })
                  }
                >
                  Clear
                </Button>
              </>
            ) : (
              <Text as="span" variant="bodySm" tone="subdued">No collection selected</Text>
            )}
          </InlineStack>
          <Select
            label="Type"
            options={types.map((value) => ({ label: value, value }))}
            value={reward.type}
            onChange={(value) => set("type", value)}
          />
          <TextField
            label="Value"
            type="number"
            value={String(reward.value)}
            onChange={(value) => set("value", value)}
            autoComplete="off"
          />
          <TextField
            label="Win chance weight"
            type="number"
            value={String(reward.weight)}
            onChange={(value) => set("weight", value)}
            autoComplete="off"
            helpText="Required for reward selection. This is a relative chance among eligible rewards: 20 is twice as likely as 10."
          />
          <TextField
            label={`Minimum order (${currencyCode})`}
            type="number"
            value={String(reward.minOrderValue)}
            onChange={(value) => set("minOrderValue", value)}
            autoComplete="off"
            helpText="Shopify checks the order total in your store currency, even when the buyer pays in another currency."
          />
          <Text as="h3" variant="headingSm">
            Customer segments
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            Leave all unchecked to allow every customer. A customer in any selected segment can receive this reward.
          </Text>
          {segments.length ? (
            segments.map((segment) => (
              <Checkbox
                key={segment.id}
                label={segment.name}
                checked={(reward.segmentIds || []).includes(segment.id)}
                onChange={(checked) => {
                  const segmentIds = checked
                    ? [...(reward.segmentIds || []), segment.id]
                    : (reward.segmentIds || []).filter((id) => id !== segment.id);
                  set("segmentIds", segmentIds);
                }}
              />
            ))
          ) : (
            <Text as="p" variant="bodySm" tone="subdued">
              No customer segments found.
            </Text>
          )}
          <FormLayout.Group condensed>
            <TextField
              label="Expiry duration"
              type="number"
              min={1}
              value={String(reward.expiryValue)}
              onChange={(value) => set("expiryValue", value)}
              autoComplete="off"
              helpText="How long the reward stays valid after it is revealed"
            />
            <Select
              label="Expiry unit"
              options={[
                { label: "Hours", value: "HOURS" },
                { label: "Days", value: "DAYS" },
                { label: "Weeks", value: "WEEKS" },
                { label: "Months", value: "MONTHS" },
              ]}
              value={reward.expiryUnit}
              onChange={(value) => set("expiryUnit", value)}
            />
          </FormLayout.Group>
          <TextField
            label="Max issued"
            type="number"
            value={String(reward.maxIssued ?? "")}
            onChange={(value) => set("maxIssued", value)}
            autoComplete="off"
            helpText="Leave blank for unlimited"
          />
          <Checkbox label="Active" checked={!!reward.active} onChange={(value) => set("active", value)} />
        </FormLayout>
        <InlineStack gap="200">
          <Button
            variant="primary"
            loading={saving || pickingImage || imageFetcher.state !== "idle"}
            disabled={saving || pickingImage || imageFetcher.state !== "idle"}
            onClick={onSave}
          >
            Save reward
          </Button>
          <Button disabled={saving} onClick={onCancel}>Cancel</Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}