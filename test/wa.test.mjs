import { test } from "node:test";
import assert from "node:assert/strict";
import { extractText } from "../src/wa.mjs";

test("extractText handles the common message shapes", () => {
  assert.equal(extractText(null), "");
  assert.equal(extractText({ conversation: "plain" }), "plain");
  assert.equal(extractText({ extendedTextMessage: { text: "ext" } }), "ext");
  assert.equal(extractText({ imageMessage: { caption: "img" } }), "img");
  assert.equal(extractText({ videoMessage: { caption: "vid" } }), "vid");
  assert.equal(extractText({ documentMessage: { caption: "doc" } }), "doc");
  assert.equal(extractText({ stickerMessage: {} }), "");
});
