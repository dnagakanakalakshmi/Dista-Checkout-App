import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import "./secrets.server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";


////////testing connection session 

async function createSession() {
  const session = await prisma.session.create({
    data: {
      shop: "distacart.myshopify.com",
      state: "nonce_state_value",
      isOnline: false,
      scope: "read_products,write_orders",
      accessToken: "shpat_xxx",

      userId: "123456789",
      firstName: "John",
      lastName: "Doe",
      email: "john@store.com",

      accountOwner: true,
      locale: "en",
      collaborator: false,
      emailVerified: true
    }
  });

  console.log("Session created:", session);
}

createSession()
  .catch(console.error)
  .finally(async () => {
    //await prisma.$disconnect();
  });

////////testing connection session end  


const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY || "",
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.January25,
  scopes: process.env.SCOPES?.split(",") || [],
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
