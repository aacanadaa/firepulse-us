/** Applies pending db/migrations to DATABASE_URL (the API also does this at startup). */
import { PostgresStore } from "../src/store/postgres.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const store = new PostgresStore(url);
try {
  const applied = await store.migrate();
  console.log(applied.length > 0 ? `applied ${applied.join(", ")}` : "database is up to date");
} finally {
  await store.close();
}
