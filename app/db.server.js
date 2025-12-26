import { PrismaClient } from "@prisma/client";

// Import secrets to trigger loading at startup
import "./secrets.server";

const prisma =
  process.env.NODE_ENV === "production"
    ? new PrismaClient()
    : global.prismaGlobal ?? (global.prismaGlobal = new PrismaClient());

export default prisma;
