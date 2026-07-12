#!/usr/bin/env node
// WhatsApp MCP server. Exposes list/read/search/send over stdio.
//
// Reads always come from the local store. For socket operations (send/delete/status):
// if the resident daemon is running, its loopback IPC is used (see ipc.mjs) — one paired
// session = one socket, and the daemon owns it. Only when no daemon is detected does this
// server open the connection itself (lazily, on first tool call). NOTHING may be written
// to stdout except the MCP protocol — so a self-owned connection uses showQr:false
// (qrcode-terminal prints to stdout). Pair separately with `npm run pair`.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { connect } from "./wa.mjs";
import { Store } from "./store.mjs";
import { daemonProxy } from "./ipc.mjs";

const store = new Store();
let sock = null; // either a daemon proxy or a self-owned Baileys socket
let connState = "init";

async function ensureSock() {
  if (sock?.isDaemonProxy && sock.dead) sock = null; // daemon died — re-detect
  // A self-owned socket that closed and won't reconnect (e.g. the daemon started later
  // and replaced this session — 440) must not stay cached, or every send fails until
  // the MCP server restarts. Drop it and re-detect: the daemon proxy will pick it up.
  if (sock && !sock.isDaemonProxy && connState === "close") sock = null;
  if (sock) return sock;
  const proxy = await daemonProxy();
  if (proxy) {
    sock = proxy;
    connState = "daemon";
    return sock;
  }
  sock = await connect({
    store,
    onSock: (s) => (sock = s), // stay on the LIVE socket across auto-reconnects
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

// Rebuild a Baileys message key from a stored message. The store id is `<jid>:<waId>`;
// strip the chat-jid prefix to recover the raw WhatsApp message id. For incoming group
// messages WhatsApp requires the author jid (participant) or it rejects the delete key.
function keyFromMessage(msg) {
  const prefix = `${msg.chatJid}:`;
  const waId = msg.id.startsWith(prefix) ? msg.id.slice(prefix.length) : msg.id;
  const key = { remoteJid: msg.chatJid, fromMe: msg.fromMe, id: waId };
  if (msg.participant) key.participant = msg.participant;
  return key;
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
      let registered, connection;
      if (sock.isDaemonProxy) {
        ({ registered, connection } = await sock.status()); // live, from the daemon
      } else {
        // creds.registered is only set for pairing-code sessions; sock.user covers QR.
        registered = !!(sock?.authState?.creds?.registered || sock?.user);
        connection = connState;
      }
      return text({
        registered,
        connection,
        via: sock.isDaemonProxy ? "daemon" : "own socket",
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

server.tool(
  "whatsapp_delete_message",
  "Delete a single WhatsApp message. Defaults to delete-for-me (removes it from YOUR view only). " +
    "Set for_everyone:true to revoke it for the recipient too — only allowed on your OWN messages, and it " +
    "leaves a visible 'message was deleted' marker. Get a message's id from whatsapp_read_conversation. " +
    "Without confirm:true this only PREVIEWS what would be deleted and does nothing.",
  {
    message_id: z
      .string()
      .describe("The `id` of a message, as returned by whatsapp_read_conversation"),
    for_everyone: z
      .boolean()
      .default(false)
      .describe("Revoke for the recipient too (own messages only). Default: delete for me only."),
    confirm: z
      .boolean()
      .default(false)
      .describe("Must be true to actually delete; otherwise previews."),
  },
  async ({ message_id, for_everyone, confirm }) => {
    try {
      const msg = store.getMessage(message_id);
      if (!msg) {
        throw new Error(
          `No stored message with id "${message_id}". Get a current id from whatsapp_read_conversation.`,
        );
      }
      if (for_everyone && !msg.fromMe) {
        throw new Error(
          "WhatsApp only lets you delete your OWN messages for everyone. Omit for_everyone to delete it just for yourself.",
        );
      }
      const scope = for_everyone ? "for-everyone (revoke)" : "for-me";
      if (!confirm) {
        return text({
          preview: true,
          would_delete: {
            id: msg.id,
            from: msg.fromMe ? "me" : "them",
            text: msg.text,
            ts: msg.ts,
          },
          scope,
          hint: "Call again with confirm:true to actually delete.",
        });
      }
      await ensureSock();
      if (!sock?.authState?.creds?.registered) {
        throw new Error("Not paired — run `npm run pair` and scan the QR first.");
      }
      const key = keyFromMessage(msg);
      // WhatsApp rejects a delete key for an incoming group message that lacks the author
      // jid. Older messages synced before participant capture won't have it — fail clearly
      // instead of letting Baileys throw a cryptic error (and never touch the local store).
      if (key.remoteJid.endsWith("@g.us") && !key.fromMe && !key.participant) {
        throw new Error(
          "Can't delete this incoming group message — its author isn't recorded locally " +
            "(it predates participant tracking). Newly received group messages can be deleted.",
        );
      }
      if (for_everyone) {
        await sock.sendMessage(msg.chatJid, { delete: key });
      } else {
        await sock.chatModify(
          { deleteForMe: { deleteMedia: false, key, timestamp: msg.ts } },
          msg.chatJid,
        );
      }
      // Only reached if the WhatsApp-side delete didn't throw.
      store.deleteMessage(message_id);
      return text({ ok: true, deleted: message_id, scope });
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "whatsapp_delete_conversation",
  "Delete an entire WhatsApp conversation FOR YOU (delete-for-me) — clears it from your devices only and does " +
    "NOT affect the other person. WhatsApp has no delete-conversation-for-everyone, so this never touches their copy. " +
    "Identify the chat by exact name, phone number (with country code), or jid. Without confirm:true this only " +
    "PREVIEWS what would be deleted and does nothing.",
  {
    chat: z.string().describe("Exact chat name, phone number, or jid"),
    confirm: z
      .boolean()
      .default(false)
      .describe("Must be true to actually delete; otherwise previews."),
  },
  async ({ chat, confirm }) => {
    try {
      const jid = resolveJid(chat);
      const info = store.chatInfo(jid);
      if (!confirm) {
        return text({
          preview: true,
          would_delete: {
            jid,
            name: info?.name || jid,
            stored_messages: info?.messageCount ?? 0,
          },
          scope: "for-me (your devices only; the other person is unaffected)",
          hint: "Call again with confirm:true to actually delete.",
        });
      }
      await ensureSock();
      if (!sock?.authState?.creds?.registered) {
        throw new Error("Not paired — run `npm run pair` and scan the QR first.");
      }
      // The WhatsApp-side delete needs an anchor message with a valid (non-zero) timestamp
      // and — for an incoming group chat — the author jid. If we can't build a valid anchor,
      // we still clear the local copy but must NOT claim WhatsApp was touched.
      const last = store.lastMessage(jid);
      const key = last ? keyFromMessage(last) : null;
      const anchorOk =
        !!last &&
        last.ts > 0 &&
        !(key.remoteJid.endsWith("@g.us") && !key.fromMe && !key.participant);
      let whatsappSide = "skipped (no valid anchor message; cleared from local store only)";
      if (anchorOk) {
        await sock.chatModify(
          { delete: true, lastMessages: [{ key, messageTimestamp: last.ts }] },
          jid,
        );
        whatsappSide = "deleted";
      }
      // Only reached if any WhatsApp-side call above didn't throw.
      const counts = store.deleteChat(jid);
      return text({
        ok: true,
        chat: jid,
        scope: "for-me",
        whatsapp_side: whatsappSide,
        removed_from_store: counts,
      });
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
