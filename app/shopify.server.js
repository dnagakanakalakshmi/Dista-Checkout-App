import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { getShopifyCredentials } from "./secrets.server";

// Get credentials synchronously from cache or environment, with async fallback
let credentialsPromise = null;
let cachedCredentials = null;

function getCredentialsSync() {
  // Return cached credentials if available
  if (cachedCredentials) {
    return cachedCredentials;
  }

  // Return environment variables as fallback
  return {
    "shopify-api-key": process.env.SHOPIFY_API_KEY || "",
    "shopify-access-secret": process.env.SHOPIFY_API_SECRET || "",
    scopes: process.env.SCOPES || "",
  };
}

// Pre-fetch credentials from AWS Secrets Manager if configured
if (process.env.AWS_APP_SECRET_NAME) {
  credentialsPromise = getShopifyCredentials()
    .then((creds) => {
      cachedCredentials = creds;
      console.log("✅ Shopify credentials loaded from AWS Secrets Manager");
      return creds;
    })
    .catch((error) => {
      console.warn("Using environment variables for Shopify credentials:", error.message);
      return getCredentialsSync();
    });
}

// Initialize Shopify app
const credentials = getCredentialsSync();
const shopify = shopifyApp({
  apiKey: credentials.shopify-api-key,
  apiSecretKey: credentials.shopify-access-secret,
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
