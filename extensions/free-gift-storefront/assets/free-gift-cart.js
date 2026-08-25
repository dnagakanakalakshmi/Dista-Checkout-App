// extensions/free-gift-cart/assets/free-gift-cart.js
(function () {
  if (window.__freeGiftCartSyncPatched) return; // guard against double-injection
  window.__freeGiftCartSyncPatched = true;

  const DEBUG = false; // flip on locally; keep off in production

  const AUTO_GIFT_KEY = "_auto_gift";
  const AUTO_GIFT_VALUE = "true";
  const CAMPAIGN_KEY = "_gift_campaign_id";
  const INTERNAL_HEADER = "X-Free-Gift-Internal";
  const DEBOUNCE_MS = 300;
  const NOTIFICATION_DURATION_MS = 4000;

  // Last-known settings from the server; updated every successful sync.
  let currentSettings = {
    notification: { enabled: false, title: "" },
  };

  function ensureToastStyles() {
    if (document.getElementById("free-gift-toast-styles")) return;
    const style = document.createElement("style");
    style.id = "free-gift-toast-styles";
    style.textContent = `
      #free-gift-toast {
        position: fixed;
        top: 24px;
        left: 50%;
        transform: translate(-50%, -20px);
        z-index: 99999;
        display: flex;
        align-items: center;
        gap: 10px;
        background: #FDC028;
        color: #fff;
        padding: 14px 22px;
        border-radius: 10px;
        font-size: 15px;
        font-weight: 600;
        line-height: 1.3;
        box-shadow: 0 8px 24px rgba(0,0,0,.18);
        opacity: 0;
        pointer-events: none;
        transition: opacity .25s ease, transform .25s ease;
        max-width: min(90vw, 420px);
        text-align: center;
      }
      #free-gift-toast.free-gift-toast--visible {
        opacity: 1;
        transform: translate(-50%, 0);
      }
      #free-gift-toast .free-gift-toast__icon {
        flex: 0 0 auto;
        font-size: 18px;
        line-height: 1;
      }
      @media (max-width: 480px) {
        #free-gift-toast {
          top: 12px;
          padding: 12px 16px;
          font-size: 14px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function showGiftNotification(title) {
    if (!title) return;
    ensureToastStyles();

    let toast = document.getElementById("free-gift-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "free-gift-toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");

      const icon = document.createElement("span");
      icon.className = "free-gift-toast__icon";
      icon.textContent = "\u{1F381}"; // 🎁
      icon.setAttribute("aria-hidden", "true");

      const text = document.createElement("span");
      text.className = "free-gift-toast__text";

      toast.appendChild(icon);
      toast.appendChild(text);
      document.body.appendChild(toast);
    }

    toast.querySelector(".free-gift-toast__text").textContent = title;

    // Restart the animation even if a toast is already showing.
    toast.classList.remove("free-gift-toast--visible");
    // Force reflow so the class removal/addition triggers a fresh transition.
    void toast.offsetWidth;
    requestAnimationFrame(() => {
      toast.classList.add("free-gift-toast--visible");
    });

    clearTimeout(showGiftNotification._timer);
    showGiftNotification._timer = setTimeout(() => {
      toast.classList.remove("free-gift-toast--visible");
    }, NOTIFICATION_DURATION_MS);
  }

  const root = document.getElementById("free-gift-cart-sync");
  if (!root) return;

  const shop = root.dataset.shop;
  let busy = false;
  let debounceTimer = null;

  function isAutoGiftItem(item) {
    return item.properties && item.properties[AUTO_GIFT_KEY] === AUTO_GIFT_VALUE;
  }

  function internalFetch(url, options = {}) {
    return fetch(url, {
      ...options,
      headers: { ...(options.headers || {}), [INTERNAL_HEADER]: "1" },
    });
  }

  const routesRoot = window.Shopify?.routes?.root || "/";

  async function fetchCart() {
    const res = await internalFetch(`${routesRoot}cart.js`);
    return res.json();
  }

  // Returns null on failure (caller must abort sync), otherwise an array of
  // { variantId, campaignId }.
  async function fetchEligibleGifts(cart) {
    const nonGiftItems = cart.items.filter((item) => !isAutoGiftItem(item));
    const subtotal =
      nonGiftItems.reduce((sum, item) => sum + item.final_line_price, 0) / 100;

    let res;
    try {
      res = await internalFetch(`/apps/dista-checkout/apps/free-gift-campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shop,
          subtotal,
          lines: nonGiftItems.map((item) => ({
            merchandiseId: `gid://shopify/ProductVariant/${item.variant_id}`,
            quantity: item.quantity,
            lineSubtotal: item.original_line_price / 100,
          })),
        }),
      });
    } catch (err) {
      return null;
    }

    if (!res.ok) {
      return null;
    }

    const data = await res.json();
    if (!data.ok) return null;

    if (data.notification) currentSettings.notification = data.notification;

    return (data.gifts || data.giftVariantIds || []).map((g) =>
      typeof g === "string"
        ? { variantId: idFromGid(g), campaignId: null }
        : { variantId: idFromGid(g.variantId), campaignId: g.campaignId ?? null }
    );
  }

  function idFromGid(gid) {
    return String(gid).split("/").pop();
  }

  function scheduleSyncGifts() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(syncGifts, DEBOUNCE_MS);
  }

  async function syncGifts() {
    if (busy) return;
    busy = true;
    try {
      const cart = await fetchCart();

      const currentGiftItems = cart.items.filter(isAutoGiftItem);

      const eligible = await fetchEligibleGifts(cart);
      if (eligible === null) {
        return;
      }

      const { notification } = currentSettings;
      const desiredVariantIds = new Set(eligible.map((g) => g.variantId));

      const seenVariants = new Set();
      let changed = false;

      for (const item of currentGiftItems) {
        const variantId = String(item.variant_id);
        const keep = desiredVariantIds.has(variantId) && !seenVariants.has(variantId);
        seenVariants.add(variantId);
        if (!keep) {
          await internalFetch(`${routesRoot}cart/change.js`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: item.key, quantity: 0 }),
          });
          changed = true;
        }
      }

      const existingVariantIds = new Set(
        currentGiftItems.map((i) => String(i.variant_id))
      );

      const addedTitles = [];

      for (const g of eligible) {
        if (existingVariantIds.has(g.variantId)) continue;

        const response = await internalFetch(`${routesRoot}cart/add.js`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: [
              {
                id: g.variantId,
                quantity: 1,
                properties: {
                  [AUTO_GIFT_KEY]: AUTO_GIFT_VALUE,
                  [CAMPAIGN_KEY]: g.campaignId || "",
                },
              },
            ],
          }),
        });

        // Only consider the gift added if Shopify actually accepted it.
        if (!response.ok) {
          console.log(
            `Free gift ${g.variantId} could not be added. Status:`,
            response.status
          );
          continue;
        }

        addedTitles.push(g.variantId);
        changed = true;
      }

      if (addedTitles.length && notification.enabled) {
        showGiftNotification(notification.title);
      }

      if (changed) {
        document.dispatchEvent(new CustomEvent("free-gift:cart-updated"));
        // await refreshCartUI();
        if (typeof BoosterTheme !== "undefined" && BoosterTheme.cart) {
          await BoosterTheme.cart.dispatchListeners({ change: true });
        }
      }
    } catch (error) {
      console.error("Free gift cart sync failed:", error);
    } finally {
      busy = false;
    }
  }

  // async function refreshCartUI() {
  //   const sectionIds = ["cart-icon-bubble", "cart-drawer"];
  //   try {
  //     const res = await internalFetch(`/?sections=${sectionIds.join(",")}`);
  //     if (!res.ok) throw new Error("section fetch failed");
  //     const sections = await res.json();

  //     for (const id of sectionIds) {
  //       const html = sections[id];
  //       const target = document.getElementById(id) || document.querySelector(`[data-section-id="${id}"]`);
  //       if (html && target) {
  //         const doc = new DOMParser().parseFromString(html, "text/html");
  //         const newEl = doc.getElementById(id) || doc.querySelector(`[data-section-id="${id}"]`);
  //         if (newEl) target.replaceWith(newEl);
  //       }
  //     }
  //   } catch (error) {
  //     window.location.reload();
  //   }
  // }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const [resource, options] = args;
    const url = typeof resource === "string" ? resource : resource?.url || "";
    const isInternal = options?.headers?.[INTERNAL_HEADER];
    if (!isInternal && /\/cart\/(change|update|add)\.js/.test(url) && response.ok) {
      scheduleSyncGifts();
    }
    return response;
  };

  document.addEventListener("cart:updated", scheduleSyncGifts);
  document.addEventListener("DOMContentLoaded", scheduleSyncGifts);
  // In case the script loads after DOMContentLoaded already fired
  if (document.readyState !== "loading") scheduleSyncGifts();
})();