# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for security vulnerabilities.

Use GitHub's [private vulnerability reporting](https://github.com/jaingxyz/whatsapp-mcp/security/advisories/new) on this repository instead. That channel notifies the maintainer privately and creates a draft advisory.

You can expect an initial response within ~7 days. Fix timelines depend on severity and reachability — this is a personal project, not a service.

## Scope

In scope:

- Code in `src/` that handles the paired session/credentials, message contents, recipient
  resolution, the SQLite store, or input validation.
- Dependency vulnerabilities flagged by Dependabot or `npm audit`.

Out of scope:

- Vulnerabilities in WhatsApp itself or in the Baileys protocol library (report upstream).
- Vulnerabilities in Claude Desktop or other MCP clients (report to those vendors).
- Risks inherent to using an unofficial, reverse-engineered protocol library against a
  service whose Terms of Service prohibit it (see the README).

## Threat model notes

- The **paired session** lives in the auth directory (`~/Library/Application Support/whatsapp-mcp/auth`
  by default). Anyone with read access to it can impersonate your WhatsApp on a linked
  device — read and send your messages. Protect the host; the directory is gitignored.
- The local **SQLite store** contains your synced message text in plaintext. It is gitignored
  and lives outside the repo.
- Only **one process** may hold the WhatsApp session at a time.
- This tool is for **personal use of your own account**. Do not use it for bulk or
  unauthorized messaging — that risks an account ban and may be unlawful.
- **Destructive tools (`delete_message`, `delete_conversation`)** are gated: they require an
  explicit `confirm: true` (otherwise they only preview), default to delete-for-me, and only
  permit delete-for-everyone on your own messages. An MCP client driven by an LLM therefore
  cannot delete content in a single careless call. Delete-for-everyone is irreversible and
  visible to the recipient — treat the `confirm` step as the real safety boundary.

## Supported versions

Only the latest commit on `main` is supported. There are no maintained release branches.
