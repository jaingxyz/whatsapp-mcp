#!/usr/bin/env node
// One-time pairing. Run `npm run pair` and scan the QR in WhatsApp → Linked devices.
// Or `npm run pair -- <phone-number-with-country-code>` to use a pairing code instead.
// Once "connected" prints, the session is saved to the auth dir; Ctrl+C to exit.

import { connect } from "./wa.mjs";

const phoneNumber = process.argv[2] || null;

await connect({
  phoneNumber,
  onUpdate: (u) => {
    if (u.connection === "open") {
      console.error("[pair] Paired and connected. Credentials saved — press Ctrl+C to exit.");
    }
  },
});

process.stdin.resume();
process.on("SIGINT", () => process.exit(0));
