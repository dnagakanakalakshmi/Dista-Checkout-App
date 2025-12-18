import { PrismaClient } from "@prisma/client";
import { getAppSecrets, getDatabaseUrl } from "./secrets.server";

// Print secrets at startup (before any DB access)
if (process.env.AWS_APP_SECRET_NAME) {
  console.log("=".repeat(60));
  console.log("🚀 App starting - fetching secrets from AWS Secrets Manager...");
  console.log("AWS_APP_SECRET_NAME:", process.env.AWS_APP_SECRET_NAME);
  console.log("=".repeat(60));
  
  getAppSecrets()
    .then((secrets) => {
      console.log("=".repeat(60));
      console.log("🔐 All secrets loaded from AWS Secrets Manager:");
      console.log("=".repeat(60));
      console.log("Secret keys:", Object.keys(secrets || {}));
      console.log("Full secrets:", JSON.stringify(secrets, null, 2));
      console.log("=".repeat(60));
    })
    .catch((error) => {
      console.error("❌ Failed to fetch secrets from AWS:", error.message);
    });
}

// Initialize Prisma with database URL from AWS Secrets Manager or environment
let prismaInstance = null;

async function getPrismaClient() {
  if (prismaInstance) {
    return prismaInstance;
  }

  // Get database URL from AWS Secrets Manager or environment
  const databaseUrl = process.env.AWS_APP_SECRET_NAME
    ? await getDatabaseUrl()
    : process.env.DATABASE_URL;

  // Update DATABASE_URL environment variable if fetched from Secrets Manager
  if (databaseUrl && databaseUrl !== process.env.DATABASE_URL) {
    process.env.DATABASE_URL = databaseUrl;
  }

  if (process.env.NODE_ENV !== "production") {
    if (!global.prismaGlobal) {
      global.prismaGlobal = new PrismaClient();
    }
    prismaInstance = global.prismaGlobal;
  } else {
    prismaInstance = new PrismaClient();
  }

  return prismaInstance;
}

// Initialize Prisma synchronously (will use env var, async update happens in background)
if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient();
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient();

// Export both sync and async versions
export default prisma;
export { getPrismaClient };
