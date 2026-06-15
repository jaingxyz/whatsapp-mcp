// Local SQLite store for WhatsApp messages.
//
// Baileys is event-driven and only delivers messages while connected, so the daemon
// writes everything it sees here and the MCP tools read from here. History therefore
// reflects what has been synced since first connect, not the entire WhatsApp past.

import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const DEFAULT_DB =
  process.env.WA_STORE_DB ||
  path.join(os.homedir(), "Library", "Application Support", "whatsapp-mcp", "store", "wa.db");

export class Store {
  constructor(dbPath = DEFAULT_DB) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        jid           TEXT PRIMARY KEY,
        name          TEXT,
        last_text     TEXT,
        last_ts       INTEGER DEFAULT 0,
        unread        INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        id        TEXT PRIMARY KEY,
        chat_jid  TEXT NOT NULL,
        from_me   INTEGER NOT NULL DEFAULT 0,
        sender    TEXT,
        text      TEXT,
        ts        INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_jid, ts);
      CREATE INDEX IF NOT EXISTS idx_chats_last_ts ON chats(last_ts DESC);
    `);
  }

  // Upsert a chat's summary row. Only advances last_text/last_ts when the incoming
  // message is newer than what we already have (out-of-order events are common).
  upsertChat({ jid, name, lastText, lastTs = 0, unread }) {
    this.db
      .prepare(
        `INSERT INTO chats (jid, name, last_text, last_ts, unread)
         VALUES (@jid, @name, @lastText, @lastTs, @unread)
         ON CONFLICT(jid) DO UPDATE SET
           name      = COALESCE(excluded.name, chats.name),
           last_text = CASE WHEN excluded.last_ts >= chats.last_ts THEN excluded.last_text ELSE chats.last_text END,
           last_ts   = MAX(excluded.last_ts, chats.last_ts),
           unread    = COALESCE(excluded.unread, chats.unread)`,
      )
      .run({
        jid,
        name: name ?? null,
        lastText: lastText ?? null,
        lastTs,
        // SQLite can't bind booleans — coerce to 1/0, or null to leave unchanged.
        unread: unread == null ? null : unread ? 1 : 0,
      });
  }

  // Insert a message; ignore if we've already stored this id (events can repeat).
  insertMessage({ id, chatJid, fromMe = false, sender, text, ts = 0 }) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (id, chat_jid, from_me, sender, text, ts)
         VALUES (@id, @chatJid, @fromMe, @sender, @text, @ts)`,
      )
      .run({ id, chatJid, fromMe: fromMe ? 1 : 0, sender: sender ?? null, text: text ?? null, ts });
  }

  listChats(limit = 20) {
    return this.db
      .prepare(
        `SELECT jid, name, last_text, last_ts, unread FROM chats ORDER BY last_ts DESC LIMIT ?`,
      )
      .all(limit)
      .map((r) => ({
        jid: r.jid,
        name: r.name || r.jid,
        snippet: r.last_text || "",
        unread: !!r.unread,
      }));
  }

  readChat(jid, limit = 30) {
    // Most recent `limit`, returned oldest-first for natural reading order.
    const rows = this.db
      .prepare(
        `SELECT from_me, sender, text, ts FROM messages WHERE chat_jid = ? ORDER BY ts DESC LIMIT ?`,
      )
      .all(jid, limit);
    return rows.reverse().map((r) => ({
      from: r.from_me ? "me" : "them",
      sender: r.sender || "",
      text: r.text || "",
      ts: r.ts,
    }));
  }

  // Case-insensitive substring search over message text and chat names.
  search(query, limit = 20) {
    const like = `%${query.replace(/[%_]/g, "")}%`;
    return this.db
      .prepare(
        `SELECT m.chat_jid AS jid, c.name AS name, m.text AS text, m.ts AS ts
         FROM messages m LEFT JOIN chats c ON c.jid = m.chat_jid
         WHERE m.text LIKE ? COLLATE NOCASE OR c.name LIKE ? COLLATE NOCASE
         ORDER BY m.ts DESC LIMIT ?`,
      )
      .all(like, like, limit)
      .map((r) => ({ jid: r.jid, name: r.name || r.jid, text: r.text || "", ts: r.ts }));
  }

  close() {
    this.db.close();
  }
}
