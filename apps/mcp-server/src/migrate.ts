import { resolve } from "node:path";
import { config } from "dotenv";
import { SqliteStore } from "../../../packages/storage/src/sqlite.js";

config({ quiet: true });
const store = new SqliteStore(resolve(process.env.DATABASE_PATH ?? ".data/inboxguardian.sqlite"));
store.migrate();
store.close();
process.stderr.write("SQLite migrations complete (version 1).\n");
