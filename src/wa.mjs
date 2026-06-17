// Baileys WhatsApp connection layer.
//
// Speaks WhatsApp's multi-device WebSocket protocol directly (no browser). The socket is
// event-driven and only delivers messages while connected, so the daemon keeps it open and
// persists everything it sees into the local Store.

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const DEFAULT_AUTH_DIR =
  process.env.WA_AUTH_DIR ||
  path.join(os.homedir(), "Library", "Application Support", "whatsapp-mcp", "auth");

// Pull plain text out of the many WhatsApp message shapes.
export function extractText(message) {
  if (!message) return "";
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    ""
  );
}

/**
 * Open a WhatsApp connection. Persists creds to `authDir` and (if a Store is given)
 * incoming messages to it. Auto-reconnects unless the session was logged out.
 * Returns the live socket.
 */
export async function connect({
  authDir = DEFAULT_AUTH_DIR,
  store = null,
  onUpdate = null,
  phoneNumber = null, // if set, request a pairing code instead of showing a QR
  showQr = true, // MUST be false for the MCP server — qrcode-terminal writes to stdout
} = {}) {
  fs.mkdirSync(authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["whatsapp-mcp", "Chrome", "1.0"],
  });
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr && !phoneNumber && showQr) {
      console.error("[wa] Scan this QR in WhatsApp → Settings → Linked devices → Link a device:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") console.error("[wa] connected.");
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.error(
        `[wa] connection closed (code ${code}); ${loggedOut ? "logged out — re-pair required" : "reconnecting in 3s"}`,
      );
      // Reconnect (without re-requesting a pairing code) unless we were logged out.
      if (!loggedOut) setTimeout(() => connect({ authDir, store, onUpdate }), 3000);
    }
    onUpdate?.(u);
  });

  // Pairing-code flow (alternative to QR) for a phone number, only if not yet registered.
  if (phoneNumber && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ""));
        console.error(`[wa] Pairing code (enter in WhatsApp → Linked devices): ${code}`);
      } catch (e) {
        console.error("[wa] pairing-code request failed:", e.message);
      }
    }, 3000);
  }

  if (store) {
    sock.ev.on("messages.upsert", ({ messages }) => {
      for (const m of messages) {
        try {
          const jid = m.key?.remoteJid;
          if (!jid || jid === "status@broadcast") continue; // skip status updates
          const id = m.key?.id ? `${jid}:${m.key.id}` : null;
          if (!id) continue;
          const text = extractText(m.message);
          const ts = Number(m.messageTimestamp || 0);
          const fromMe = !!m.key.fromMe;
          store.insertMessage({
            id,
            chatJid: jid,
            fromMe,
            sender: m.pushName || (fromMe ? "me" : jid),
            text,
            ts,
          });
          store.upsertChat({
            jid,
            name: m.pushName || undefined,
            lastText: text,
            lastTs: ts,
            unread: !fromMe,
          });
        } catch (e) {
          console.error("[wa] store write failed:", e.message);
        }
      }
    });
  }

  return sock;
}
