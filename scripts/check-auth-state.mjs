import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const p = path.join(
  process.env.APPDATA!,
  "Cursor",
  "User",
  "globalStorage",
  "state.vscdb",
);
const db = new DatabaseSync(p);
const rows = db
  .prepare(
    "SELECT key, value FROM ItemTable WHERE key LIKE 'cursorAuth/%' ORDER BY key",
  )
  .all() as Array<{ key: string; value: unknown }>;
for (const r of rows) {
  console.log(r.key, "=", String(r.value).slice(0, 100));
}
db.close();