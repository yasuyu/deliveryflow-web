
import { defineConfig, env } from "prisma/config";

const isPostgresql = process.env.DATABASE_PROVIDER === "postgresql";

export default defineConfig({
  schema: isPostgresql ? "prisma/schema.postgresql.prisma" : "prisma/schema.prisma",
  migrations: {
    path: isPostgresql ? "prisma/migrations-postgresql" : "prisma/migrations",
  },
  engine: "classic",
  datasource: {
    url: env("DATABASE_URL"),
  },
});
