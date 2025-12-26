import { PrismaClient } from "@prisma/client";
// Import secrets first - top-level await ensures secrets are loaded before we proceed
import { getDatabaseUrl } from "./secrets.server";

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

// Get database URL using top-level await (secrets already loaded from secrets.server.js)
const databaseUrl = await getDatabaseUrl();
if (databaseUrl && databaseUrl !== process.env.DATABASE_URL) {
  process.env.DATABASE_URL = databaseUrl;
  console.log("🗄️ Database URL loaded from AWS Secrets Manager");
}

// Initialize Prisma synchronously now that DATABASE_URL is set
if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient();
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient();

// Export both sync and async versions
export default prisma;
export { getPrismaClient };
