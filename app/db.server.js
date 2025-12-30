import { PrismaClient } from "@prisma/client";

function getDatabaseUrl() {
  // Loaded from process.env (AWS Secrets, ENV, etc.)
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not defined");
  }
  return process.env.DATABASE_URL;
}

export const prisma =
  global.prisma ||
  new PrismaClient({
    datasources: {
      db: {
        url: getDatabaseUrl(),
      },
    },
    log: ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") {
  global.prismaGlobal ?? (global.prismaGlobal = new PrismaClient());
}
