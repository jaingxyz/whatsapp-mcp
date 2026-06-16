#!/usr/bin/env node
// Resident daemon: holds the WhatsApp connection open and persists every message it sees
// into the local SQLite store, so the MCP tools have something to read. Auto-reconnects.
// Requires a paired session (run `npm run pair` first). Ctrl+C to stop.

import { connect } from "./wa.mjs";
import { Store } from "./store.mjs";

const store = new Store();
await connect({ store });
console.error(
  "[daemon] running — persisting WhatsApp messages to the local store. Ctrl+C to stop.",
);

process.stdin.resume();
const shutdown = () => {
  try {
    store.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
