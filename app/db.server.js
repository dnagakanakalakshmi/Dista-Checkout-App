import { PrismaClient } from "@prisma/client";

function getDatabaseUrl() {
  // Loaded from process.env (AWS Secrets, ENV, etc.)
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not defined");
  }
  return process.env.DATABASE_URL;
}

const prisma =
  process.env.NODE_ENV === "production"
    ? new PrismaClient({
    datasources: {
      db: {
        url: getDatabaseUrl(),
      },
    },
    log: ["error", "warn"],
  })
    : global.prismaGlobal ?? (global.prismaGlobal = new PrismaClient());

export default prisma;