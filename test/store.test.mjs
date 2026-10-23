import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Store } from "../src/store.mjs";

let dir;
let store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-store-"));
  store = new Store(path.join(dir, "nested", "wa.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("upsertChat only advances last message for newer events", () => {
  store.upsertChat({ jid: "a@s", name: "Alice", lastText: "new", lastTs: 200, unread: true });
  store.upsertChat({ jid: "a@s", lastText: "old", lastTs: 100 });
  const [chat] = store.listChats();
  assert.equal(chat.name, "Alice");
  assert.equal(chat.snippet, "new");
  assert.equal(chat.unread, true);
});

test("listChats orders by recency and falls back to contact name, then jid", () => {
  store.upsertChat({ jid: "a@s", lastTs: 1 });
  store.upsertChat({ jid: "b@s", lastTs: 2 });
  store.upsertContact("a@s", "Alice");
  store.upsertContact("x@s", ""); // ignored
  assert.deepEqual(
    store.listChats().map((c) => c.name),
    ["b@s", "Alice"],
  );
});

test("insertMessage ignores duplicate ids; readChat returns oldest-first", () => {
  store.insertMessage({ id: "m2", chatJid: "a@s", text: "second", ts: 2 });
  store.insertMessage({ id: "m1", chatJid: "a@s", fromMe: true, text: "first", ts: 1 });
  store.insertMessage({ id: "m1", chatJid: "a@s", text: "dupe", ts: 9 });
  const msgs = store.readChat("a@s");
  assert.deepEqual(
    msgs.map((m) => [m.id, m.from, m.text]),
    [
      ["m1", "me", "first"],
      ["m2", "them", "second"],
    ],
  );
  assert.equal(store.readChat("a@s", 1)[0].id, "m2");
});

test("deleteMessage refreshes the chat's last message atomically", () => {
  store.upsertChat({ jid: "a@s", lastText: "second", lastTs: 2 });
  store.insertMessage({ id: "m1", chatJid: "a@s", text: "first", ts: 1 });
  store.insertMessage({ id: "m2", chatJid: "a@s", text: "second", ts: 2 });
  assert.equal(store.deleteMessage("m2"), 1);
  assert.equal(store.deleteMessage("missing"), 0);
  assert.equal(store.listChats()[0].snippet, "first");
  assert.equal(store.lastMessage("a@s").id, "m1");
});

test("deleteChat removes messages and summary but keeps contact names", () => {
  store.upsertChat({ jid: "a@s", lastTs: 1 });
  store.upsertContact("a@s", "Alice");
  store.insertMessage({ id: "m1", chatJid: "a@s", text: "hi", ts: 1 });
  assert.deepEqual(store.deleteChat("a@s"), { messages: 1, chats: 1 });
  assert.equal(store.chatInfo("a@s"), null);
  assert.equal(store.jidForName("alice"), "a@s");
});

test("search is case-insensitive and strips LIKE wildcards", () => {
  store.upsertChat({ jid: "a@s", name: "Alice", lastTs: 1 });
  store.insertMessage({ id: "m1", chatJid: "a@s", text: "Lunch at Noon", ts: 1 });
  store.insertMessage({ id: "m2", chatJid: "b@s", text: "unrelated", ts: 2 });
  assert.deepEqual(
    store.search("noon").map((r) => r.text),
    ["Lunch at Noon"],
  );
  assert.equal(store.search("%").length, 2); // "%" stripped -> matches everything
});

test("jidForName throws on ambiguity and returns null when unknown", () => {
  store.upsertContact("a@s", "Sam");
  store.upsertContact("b@s", "sam");
  assert.throws(() => store.jidForName("SAM"), /matches 2/);
  assert.equal(store.jidForName("nobody"), null);
});

test("migrates a pre-participant schema in place", () => {
  const legacy = path.join(dir, "legacy.db");
  const db = new Database(legacy);
  db.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, chat_jid TEXT NOT NULL,
           from_me INTEGER NOT NULL DEFAULT 0, sender TEXT, text TEXT, ts INTEGER NOT NULL DEFAULT 0)`);
  db.close();
  const s = new Store(legacy);
  s.insertMessage({ id: "g1", chatJid: "g@g.us", text: "x", ts: 1, participant: "p@s" });
  assert.equal(s.getMessage("g1").participant, "p@s");
  s.close();
});
