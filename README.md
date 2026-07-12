# WhatsApp MCP

A [Baileys](https://github.com/WhiskeySockets/Baileys)-based MCP server for WhatsApp:
a persistent connection that maintains a local message store, exposing tools to **list,
read, search, and send** — so an MCP client (Claude, or an agent like `garvis`) can work
with your WhatsApp messages.

Unlike scraping WhatsApp Web in a browser, this speaks WhatsApp's WebSocket multi-device
protocol directly: **no browser, no DOM selectors, no headless crashes.**

## Status

🚧 Early/local development. Not yet published.

## How it works

WhatsApp's multi-device protocol is event-driven and only delivers messages while you're
connected, so this runs as a **resident connection + local store**:

- **Daemon** — holds the WebSocket connection, persists incoming messages to a local
  SQLite store, and auto-reconnects. Auth is a paired session (`useMultiFileAuthState`),
  created once via QR / pairing code.
- **MCP server** — reads the store and sends via the socket, exposing the tools.

One paired session = one socket, so the two coordinate instead of fighting over it:
while the daemon runs, it is the sole socket owner and serves a **loopback IPC**
(`daemon.json` next to the store: pid + random port + per-run token, 127.0.0.1 only).
The MCP server auto-detects it and proxies socket ops (send/delete/status) through it;
reads always hit the shared WAL-mode SQLite store directly. With no daemon running, the
MCP server opens the socket itself, as before. If the daemon dies mid-session the proxy
flags itself dead and the next tool call falls back to a self-owned socket.

### Run the daemon persistently (macOS)

```bash
cp com.whatsapp-mcp.daemon.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.whatsapp-mcp.daemon.plist   # start + at login
tail -f ~/Library/Logs/whatsapp-mcp-daemon.log                           # watch it
launchctl unload -w ~/Library/LaunchAgents/com.whatsapp-mcp.daemon.plist # stop
```

A resident daemon means the store keeps filling 24/7 (better history than the MCP
server's lazy on-demand connection) and MCP clients get instant reads.

> History reflects what has been synced since you connected (on-connect sync + live
> events), not your entire WhatsApp past.

## ⚠️ Important caveats

- **Unofficial.** This uses a reverse-engineered protocol library and is **against
  WhatsApp's Terms of Service.** Accounts can be banned, especially for high-volume or
  spammy automation. Use a number you can afford to lose; for sanctioned automation use
  the WhatsApp Business Cloud API instead.
- **Personal use only**, low volume, people you know.
- **Deletion is guarded**, never automatic: it requires an explicit `confirm: true`
  (otherwise the tool only previews), defaults to delete-_for-me_, and only allows
  delete-_for-everyone_ on your own messages. See the [security model](SECURITY.md).

## Tools

All tools are prefixed `whatsapp_` to avoid name collisions with other MCP servers.

| Tool                  | What it does                                                           |
| --------------------- | ---------------------------------------------------------------------- |
| `pairing_status`      | Whether the session is paired and connected                            |
| `list_conversations`  | Recent chats (name, last-message snippet, unread)                      |
| `read_conversation`   | Recent messages in a chat (each with an `id` for deletion)             |
| `send_message`        | Send a text to a chat / number                                         |
| `search_messages`     | Search the local store                                                 |
| `delete_message`      | Delete one message — for-me by default; for-everyone (own msgs) opt-in |
| `delete_conversation` | Delete a whole conversation for-me (never affects the other person)    |

> **Delete semantics.** "For me" clears the message/chat from _your_ devices only.
> "For everyone" (messages only, your own only) revokes it for the recipient and leaves a
> visible "this message was deleted" marker. Both require `confirm: true`; without it the
> tool returns a preview and does nothing. Deletes are applied to the local store optimistically;
> a long-running daemon may re-sync a deleted-for-me item if WhatsApp re-delivers it.

## License

[GNU AGPL-3.0-or-later](LICENSE). Note the network-use clause: running a modified version
as a network service obligates you to offer its source to users.
