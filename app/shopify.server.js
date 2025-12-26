import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
// Import secrets - the top-level await in secrets.server.js ensures secrets are loaded
import { getShopifyCredentials } from "./secrets.server";

// Get credentials - secrets are already loaded due to top-level await in secrets.server.js
const credentials = await getShopifyCredentials();

console.log("🔑 Shopify credentials loaded:", {
  hasApiKey: !!credentials.apiKey,
  hasApiSecret: !!credentials.apiSecret,
  scopes: credentials.scopes,
});

// Initialize Shopify app with loaded credentials
const shopify = shopifyApp({
  apiKey: credentials.apiKey,
  apiSecretKey: credentials.apiSecret,
  apiVersion: ApiVersion.January25,
  scopes: credentials.scopes?.split(",") || process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    removeRest: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.January25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
