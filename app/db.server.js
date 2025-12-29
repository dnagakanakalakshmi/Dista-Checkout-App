// Import secrets to trigger loading at startup
import "./secrets.server";
import { PrismaClient } from "@prisma/client";

if (!process.env.DATABASE_URL) {
  await loadSecrets();
}

const prisma =
  process.env.NODE_ENV === "production"
    ? new PrismaClient()
    : global.prismaGlobal ?? (global.prismaGlobal = new PrismaClient());

export default prisma;
