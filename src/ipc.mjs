// Localhost IPC between the resident daemon and the MCP server.
//
// One paired session = one socket, so when the daemon is running it is the sole owner of
// the WhatsApp connection. Reads never come through here — both processes read the
// WAL-mode SQLite store directly. Only the operations that need the live socket
// (sendMessage / chatModify / status) are proxied.
//
// Discovery: the daemon listens on 127.0.0.1 (random port) and writes daemon.json
// {pid, port, token} next to the store. The MCP server uses the daemon iff that file
// exists, the pid is alive, and /status answers with the matching token. The token is
// random per daemon run and the listener is loopback-only.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const DAEMON_FILE =
  process.env.WA_DAEMON_FILE ||
  path.join(os.homedir(), "Library", "Application Support", "whatsapp-mcp", "daemon.json");

// JSON.stringify that survives Baileys' Long/BigInt-bearing results.
const safe = (obj) => JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? String(v) : v));

const MAX_BODY = 256 * 1024; // plenty for a send payload; rejects runaway bodies

const tokenMatches = (given, token) => {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/** Daemon side: serve socket ops. getSock() returns the CURRENT live socket. */
export function startIpc({ getSock, getStatus }) {
  const token = crypto.randomBytes(24).toString("hex");

  const server = http.createServer(async (req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(safe(body));
    };
    if (!tokenMatches(req.headers["x-wa-token"], token))
      return reply(403, { ok: false, error: "bad token" });
    if (req.method !== "POST") return reply(405, { ok: false, error: "POST only" });

    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > MAX_BODY) {
        reply(413, { ok: false, error: "body too large" });
        req.destroy();
      }
    });
    req.on("end", async () => {
      try {
        const { op, jid, content, mod } = JSON.parse(raw || "{}");
        if (op === "status") return reply(200, { ok: true, result: getStatus() });
        const sock = getSock();
        if (!sock) return reply(503, { ok: false, error: "daemon has no live socket yet" });
        if (op === "send") {
          const result = await sock.sendMessage(jid, content);
          return reply(200, { ok: true, result });
        }
        if (op === "chatModify") {
          const result = await sock.chatModify(mod, jid);
          return reply(200, { ok: true, result });
        }
        return reply(400, { ok: false, error: `unknown op ${op}` });
      } catch (e) {
        // Log the detail server-side (loopback daemon stderr), but never return the
        // exception text — which can carry a stack trace — over the wire.
        console.error("[ipc] op failed:", e?.stack || e?.message || String(e));
        return reply(500, { ok: false, error: "internal error" });
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      fs.mkdirSync(path.dirname(DAEMON_FILE), { recursive: true });
      // unlink first: writeFileSync's mode only applies on creation, and the token
      // must never be readable by other users even if a stale file had loose perms
      try {
        fs.unlinkSync(DAEMON_FILE);
      } catch {
        /* didn't exist */
      }
      fs.writeFileSync(DAEMON_FILE, safe({ pid: process.pid, port, token }), { mode: 0o600 });
      console.error(`[ipc] daemon IPC on 127.0.0.1:${port} (${DAEMON_FILE})`);
      resolve({
        close: () => {
          try {
            fs.unlinkSync(DAEMON_FILE);
          } catch {
            /* already gone */
          }
          server.close();
        },
      });
    });
  });
}

/**
 * MCP-server side: return a proxy for the running daemon, or null if none is usable.
 * The proxy exposes sendMessage/chatModify/status with the same shapes the socket has.
 */
export async function daemonProxy() {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(DAEMON_FILE, "utf8"));
  } catch {
    return null; // no daemon file -> no daemon
  }
  try {
    process.kill(info.pid, 0); // liveness: throws if the pid is gone
  } catch {
    return null;
  }

  const proxy = { isDaemonProxy: true, dead: false };
  const rpc = async (body) => {
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${info.port}/`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-wa-token": info.token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      // Network-level failure: the daemon is gone. Flag it so the MCP server's next
      // ensureSock() drops this proxy and falls back to owning the socket itself.
      proxy.dead = true;
      throw new Error(`whatsapp daemon unreachable (${e.message}); retry the call`);
    }
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || `daemon rpc failed (${res.status})`);
    return data.result;
  };

  try {
    const status = await rpc({ op: "status" }); // handshake: proves port+token are live
    proxy.status = () => rpc({ op: "status" });
    proxy.sendMessage = (jid, content) => rpc({ op: "send", jid, content });
    proxy.chatModify = (mod, jid) => rpc({ op: "chatModify", mod, jid });
    proxy.authState = { creds: { registered: !!status.registered } }; // shape-compat
    return proxy;
  } catch {
    return null; // stale daemon.json or daemon mid-restart -> fall back to own socket
  }
}
