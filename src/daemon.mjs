#!/usr/bin/env node
// Resident daemon: holds the WhatsApp connection open and persists every message it sees
// into the local SQLite store, so the MCP tools have something to read. Auto-reconnects.
// Requires a paired session (run `npm run pair` first). Ctrl+C to stop.
//
// While running it also serves a loopback IPC (see ipc.mjs) so the MCP server proxies
// socket operations here instead of opening a second socket against the same session.

import { connect } from "./wa.mjs";
import { Store } from "./store.mjs";
import { startIpc } from "./ipc.mjs";

const store = new Store();

let current = null; // the LIVE socket — refreshed by onSock on every (re)connect
let connState = "init";

await connect({
  store,
  onSock: (s) => (current = s),
  onUpdate: (u) => {
    if (u.connection) connState = u.connection;
  },
});

const ipc = await startIpc({
  getSock: () => current,
  getStatus: () => ({
    // creds.registered is only set for pairing-code sessions; QR-linked sessions leave
    // it false. sock.user is populated for any logged-in session, so check both.
    registered: !!(current?.authState?.creds?.registered || current?.user),
    connection: connState,
  }),
});

console.error(
  "[daemon] running — persisting WhatsApp messages to the local store. Ctrl+C to stop.",
);

process.stdin.resume();
const shutdown = () => {
  try {
    ipc.close();
  } catch {
    /* ignore */
  }
  try {
    store.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
