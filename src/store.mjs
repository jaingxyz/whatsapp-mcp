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
      -- jid -> display name registry, fed by contacts.* and groups.* events.
      CREATE TABLE IF NOT EXISTS contacts (
        jid   TEXT PRIMARY KEY,
        name  TEXT
      );
    `);
    // The author jid of a group message — required to build a valid delete key for
    // incoming group messages (Baileys rejects a non-fromMe group key without it).
    // Added after the initial schema, so migrate existing DBs in place.
    const hasParticipant = this.db
      .prepare(`SELECT 1 FROM pragma_table_info('messages') WHERE name = 'participant'`)
      .get();
    if (!hasParticipant) {
      this.db.exec(`ALTER TABLE messages ADD COLUMN participant TEXT`);
    }
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

  // Register/refresh a jid's display name (contact or group). Ignores empties.
  upsertContact(jid, name) {
    if (!jid || !name) return;
    this.db
      .prepare(
        `INSERT INTO contacts (jid, name) VALUES (?, ?)
         ON CONFLICT(jid) DO UPDATE SET name = excluded.name`,
      )
      .run(jid, name);
  }

  // Insert a message; ignore if we've already stored this id (events can repeat).
  insertMessage({ id, chatJid, fromMe = false, sender, text, ts = 0, participant = null }) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (id, chat_jid, from_me, sender, text, ts, participant)
         VALUES (@id, @chatJid, @fromMe, @sender, @text, @ts, @participant)`,
      )
      .run({
        id,
        chatJid,
        fromMe: fromMe ? 1 : 0,
        sender: sender ?? null,
        text: text ?? null,
        ts,
        participant: participant ?? null,
      });
  }

  listChats(limit = 20) {
    return this.db
      .prepare(
        `SELECT c.jid AS jid,
                COALESCE(NULLIF(c.name, ''), n.name) AS name,
                c.last_text AS last_text, c.last_ts AS last_ts, c.unread AS unread
         FROM chats c LEFT JOIN contacts n ON n.jid = c.jid
         ORDER BY c.last_ts DESC LIMIT ?`,
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
    // `id` is included so callers can reference a specific message for deletion.
    const rows = this.db
      .prepare(
        `SELECT id, from_me, sender, text, ts FROM messages WHERE chat_jid = ? ORDER BY ts DESC LIMIT ?`,
      )
      .all(jid, limit);
    return rows.reverse().map((r) => ({
      id: r.id,
      from: r.from_me ? "me" : "them",
      sender: r.sender || "",
      text: r.text || "",
      ts: r.ts,
    }));
  }

  // Fetch one stored message by its store id (`<jid>:<waMessageId>`), or null.
  getMessage(id) {
    const r = this.db
      .prepare(
        `SELECT id, chat_jid, from_me, sender, text, ts, participant FROM messages WHERE id = ?`,
      )
      .get(id);
    if (!r) return null;
    return {
      id: r.id,
      chatJid: r.chat_jid,
      fromMe: !!r.from_me,
      sender: r.sender || "",
      text: r.text || "",
      ts: r.ts,
      participant: r.participant || null,
    };
  }

  // Latest stored message in a chat (for building the delete "last messages" anchor), or null.
  lastMessage(jid) {
    const r = this.db
      .prepare(
        `SELECT id, chat_jid, from_me, ts, participant FROM messages WHERE chat_jid = ? ORDER BY ts DESC LIMIT 1`,
      )
      .get(jid);
    if (!r) return null;
    return {
      id: r.id,
      chatJid: r.chat_jid,
      fromMe: !!r.from_me,
      ts: r.ts,
      participant: r.participant || null,
    };
  }

  // Summary of a chat for delete previews: resolved name + stored-message count. null if unknown.
  chatInfo(jid) {
    const row = this.db
      .prepare(
        `SELECT COALESCE(NULLIF(c.name, ''), n.name) AS name
         FROM chats c LEFT JOIN contacts n ON n.jid = c.jid WHERE c.jid = ?`,
      )
      .get(jid);
    const count = this.db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ?`)
      .get(jid).n;
    if (!row && count === 0) return null;
    return { jid, name: row?.name || jid, messageCount: count };
  }

  // Remove one stored message and refresh its chat's denormalized last-message fields.
  // Atomic so a crash can't leave the chat snippet pointing at a deleted message.
  // Returns the number of message rows deleted (0 or 1).
  deleteMessage(id) {
    const msg = this.getMessage(id);
    if (!msg) return 0;
    return this.db.transaction(() => {
      const changes = this.db.prepare(`DELETE FROM messages WHERE id = ?`).run(id).changes;
      this._refreshChatLast(msg.chatJid);
      return changes;
    })();
  }

  // Remove a whole conversation from the local store (its messages + summary row), atomically.
  // Leaves the contact/group name registry intact. Returns counts.
  deleteChat(jid) {
    return this.db.transaction(() => {
      const messages = this.db.prepare(`DELETE FROM messages WHERE chat_jid = ?`).run(jid).changes;
      const chats = this.db.prepare(`DELETE FROM chats WHERE jid = ?`).run(jid).changes;
      return { messages, chats };
    })();
  }

  // Recompute a chat's denormalized last_text/last_ts from its remaining messages.
  _refreshChatLast(jid) {
    const last = this.db
      .prepare(`SELECT text, ts FROM messages WHERE chat_jid = ? ORDER BY ts DESC LIMIT 1`)
      .get(jid);
    this.db
      .prepare(`UPDATE chats SET last_text = ?, last_ts = ? WHERE jid = ?`)
      .run(last?.text ?? null, last?.ts ?? 0, jid);
  }

  // Case-insensitive substring search over message text and chat names.
  search(query, limit = 20) {
    const like = `%${query.replace(/[%_]/g, "")}%`;
    return this.db
      .prepare(
        `SELECT m.chat_jid AS jid,
                COALESCE(NULLIF(c.name, ''), n.name) AS name,
                m.text AS text, m.ts AS ts
         FROM messages m
         LEFT JOIN chats c ON c.jid = m.chat_jid
         LEFT JOIN contacts n ON n.jid = m.chat_jid
         WHERE m.text LIKE ? COLLATE NOCASE
            OR c.name LIKE ? COLLATE NOCASE
            OR n.name LIKE ? COLLATE NOCASE
         ORDER BY m.ts DESC LIMIT ?`,
      )
      .all(like, like, like, limit)
      .map((r) => ({ jid: r.jid, name: r.name || r.jid, text: r.text || "", ts: r.ts }));
  }

  // Resolve an exact (case-insensitive) name to its jid, across chat names AND the
  // contact/group name registry. Throws on ambiguity; null if unknown.
  jidForName(name) {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT jid FROM (
           SELECT jid FROM chats    WHERE name = ? COLLATE NOCASE
           UNION
           SELECT jid FROM contacts WHERE name = ? COLLATE NOCASE
         )`,
      )
      .all(name, name);
    if (rows.length > 1) {
      throw new Error(
        `"${name}" matches ${rows.length} chats/contacts — use the phone number or jid instead.`,
      );
    }
    return rows.length ? rows[0].jid : null;
  }

  close() {
    this.db.close();
  }
}
