import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-ipc-"));
process.env.WA_DAEMON_FILE = path.join(dir, "daemon.json");
const { startIpc, daemonProxy, DAEMON_FILE } = await import("../src/ipc.mjs");

const sent = [];
const sock = {
  sendMessage: async (jid, content) => {
    sent.push([jid, content]);
    return { key: { id: "abc" }, big: 10n };
  },
  chatModify: async () => {
    throw new Error("secret stack detail");
  },
};
let ipc;

before(async () => {
  ipc = await startIpc({ getSock: () => sock, getStatus: () => ({ registered: true }) });
});
after(() => {
  ipc.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("daemon file is written owner-only with a token", () => {
  const info = JSON.parse(fs.readFileSync(DAEMON_FILE, "utf8"));
  assert.equal(info.pid, process.pid);
  assert.match(info.token, /^[0-9a-f]{48}$/);
  if (process.platform !== "win32") assert.equal(fs.statSync(DAEMON_FILE).mode & 0o777, 0o600);
});

test("requests without the token are rejected", async () => {
  const { port } = JSON.parse(fs.readFileSync(DAEMON_FILE, "utf8"));
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "x-wa-token": "wrong" },
    body: JSON.stringify({ op: "status" }),
  });
  assert.equal(res.status, 403);
});

test("proxy handshakes, sends (BigInt-safe), and hides server error detail", async () => {
  const proxy = await daemonProxy();
  assert.ok(proxy?.isDaemonProxy);
  assert.equal(proxy.authState.creds.registered, true);
  const result = await proxy.sendMessage("a@s", { text: "hi" });
  assert.equal(result.big, "10");
  assert.deepEqual(sent, [["a@s", { text: "hi" }]]);
  await assert.rejects(proxy.chatModify({}, "a@s"), /^Error: internal error$/);
});

test("proxy is null when the daemon pid is dead", async () => {
  const info = JSON.parse(fs.readFileSync(DAEMON_FILE, "utf8"));
  const saved = fs.readFileSync(DAEMON_FILE);
  fs.writeFileSync(DAEMON_FILE, JSON.stringify({ ...info, pid: 2 ** 22 + 12345 }));
  try {
    assert.equal(await daemonProxy(), null);
  } finally {
    fs.writeFileSync(DAEMON_FILE, saved);
  }
});
