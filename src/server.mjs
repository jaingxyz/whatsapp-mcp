#!/usr/bin/env node
// WhatsApp MCP server. Exposes list/read/search/send over stdio.
//
// The server owns the WhatsApp connection (lazily, on first tool call) AND reads the local
// store the connection fills. NOTHING may be written to stdout except the MCP protocol — so
// the connection is opened with showQr:false (qrcode-terminal prints to stdout). Pair
// separately with `npm run pair`.
//
// One paired session = one socket: don't run the MCP server and the standalone daemon at the
// same time (they'd fight over the same credentials).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { connect } from "./wa.mjs";
import { Store } from "./store.mjs";

const store = new Store();
let sock = null;
let connState = "init";

async function ensureSock() {
  if (sock) return sock;
  sock = await connect({
    store,
    showQr: false, // never print a QR to stdout — it would corrupt the MCP stream
    onUpdate: (u) => {
      if (u.connection) connState = u.connection;
    },
  });
  return sock;
}

// Map a user-supplied target to a WhatsApp jid: a jid passes through, a phone number
// (with country code) becomes <digits>@s.whatsapp.net, otherwise it's an exact chat name
// looked up in the store.
function resolveJid(to) {
  const t = String(to).trim();
  if (t.includes("@")) return t;
  if (/^[0-9 +()-]+$/.test(t)) {
    const digits = t.replace(/[^0-9]/g, "");
    if (digits.length >= 7) return `${digits}@s.whatsapp.net`;
  }
  const jid = store.jidForName(t);
  if (!jid) {
    throw new Error(
      `No chat named "${t}" in the local store. Use a phone number (with country code) or an exact name from list_conversations.`,
    );
  }
  return jid;
}

const server = new McpServer({ name: "whatsapp", version: "0.1.0" });
const text = (o) => ({
  content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }],
});
const fail = (e) => ({
  content: [{ type: "text", text: `Error: ${e.message || e}` }],
  isError: true,
});

server.tool(
  "whatsapp_pairing_status",
  "Check whether the WhatsApp session is paired and connected. If not paired, pair separately with `npm run pair`.",
  {},
  async () => {
    try {
      await ensureSock();
      const registered = !!sock?.authState?.creds?.registered;
      return text({
        registered,
        connection: connState,
        hint: registered ? undefined : "Not paired — run `npm run pair` and scan the QR.",
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "whatsapp_list_conversations",
  "List recent WhatsApp chats from the local store (name, last-message snippet, unread). The store is filled by the live connection; very recent history may take a moment to sync.",
  { limit: z.number().int().min(1).max(50).default(20).describe("Max chats to return") },
  async ({ limit }) => {
    try {
      return text(store.listChats(limit));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "whatsapp_read_conversation",
  "Read recent messages in a chat — by exact chat name, phone number (with country code), or jid.",
  {
    chat: z.string().describe("Exact chat name, phone number, or jid"),
    limit: z.number().int().min(1).max(100).default(30),
  },
  async ({ chat, limit }) => {
    try {
      return text(store.readChat(resolveJid(chat), limit));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "whatsapp_search_messages",
  "Search the local WhatsApp store by message text or chat name (case-insensitive). Covers what has synced to the store, not your entire WhatsApp history.",
  { query: z.string(), limit: z.number().int().min(1).max(50).default(20) },
  async ({ query, limit }) => {
    try {
      const q = query.trim();
      if (!q) return text([]);
      return text(store.search(q, limit));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "whatsapp_send_message",
  "Send a WhatsApp text. `to` is a phone number (with country code), an exact chat name, or a jid. Requires a paired session.",
  { to: z.string().describe("Phone number, exact chat name, or jid"), text: z.string() },
  async ({ to, text: body }) => {
    try {
      await ensureSock();
      if (!sock?.authState?.creds?.registered) {
        throw new Error("Not paired — run `npm run pair` and scan the QR first.");
      }
      const jid = resolveJid(to);
      const res = await sock.sendMessage(jid, { text: body });
      return text({ ok: true, to: jid, id: res?.key?.id || null });
    } catch (e) {
      return fail(e);
    }
  },
);

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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[whatsapp-mcp] server ready on stdio");
