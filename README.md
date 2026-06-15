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

> History reflects what has been synced since you connected (on-connect sync + live
> events), not your entire WhatsApp past.

## ⚠️ Important caveats

- **Unofficial.** This uses a reverse-engineered protocol library and is **against
  WhatsApp's Terms of Service.** Accounts can be banned, especially for high-volume or
  spammy automation. Use a number you can afford to lose; for sanctioned automation use
  the WhatsApp Business Cloud API instead.
- **Personal use only**, low volume, people you know.
- **No auto-deletion** of chats in this version (read/list/search/send only).

## Tools (planned)

| Tool                 | What it does                                      |
| -------------------- | ------------------------------------------------- |
| `list_conversations` | Recent chats (name, last-message snippet, unread) |
| `read_conversation`  | Recent messages in a chat                         |
| `send_message`       | Send a text to a chat / number                    |
| `search_messages`    | Search the local store                            |

## License

[GNU AGPL-3.0-or-later](LICENSE). Note the network-use clause: running a modified version
as a network service obligates you to offer its source to users.
