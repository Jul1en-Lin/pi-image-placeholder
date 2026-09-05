import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ImageRegistry, newImageState, parseImagePaths, MAX_IMAGE_BYTES } from "../src/images.ts";
import { attachImages } from "../src/index.ts";
import { PNG } from "./helpers.ts";

test("parse Finder quoted/escaped/Unicode/multiple paths and file URLs without shell execution", () => {
  assert.deepEqual(parseImagePaths("'/tmp/a b.png' /tmp/中文\\ 图.jpg ", "/"), ["/tmp/a b.png", "/tmp/中文 图.jpg"]);
  assert.deepEqual(parseImagePaths("file:///tmp/a%20b.png", "/"), ["/tmp/a b.png"]);
  assert.deepEqual(parseImagePaths('"/tmp/a \'b.png" ./local.webp', "/work"), ["/tmp/a 'b.png", "/work/local.webp"]);
  for (const text of ["look /tmp/a.png", "https://example.org/a.png", "/tmp/a.png /tmp/a.pdf", "'/tmp/unfinished.png", "[Image #1]", "echo x; /tmp/a.png"]) assert.equal(parseImagePaths(text, "/"), null);
});

test("snapshot is independent, private, numbered stably and attachments use actual bytes", t => {
  const source = mkdtempSync(join(tmpdir(), "image-source-test-"));
  const registry = new ImageRegistry(newImageState());
  t.after(() => { rmSync(source, { recursive: true, force: true }); registry.dispose(); });
  const original = join(source, "中文 image.png");
  writeFileSync(original, PNG);
  const [a, b] = registry.addPaths([original, original]);
  assert.equal(a.label, "[Image #1]"); assert.equal(b.label, "[Image #2]");
  assert.notEqual(a.token, a.label);
  assert.equal(registry.display(a.token), a.label);
  assert.equal(statSync(a.path).mode & 0o777, 0o600);
  assert.equal(statSync(registry.state.directory!).mode & 0o777, 0o700);
  writeFileSync(original, "replaced"); rmSync(original);
  const result = attachImages(registry, `compare ${a.token} and ${b.token}`);
  assert.equal(result.images.length, 2);
  assert.equal(result.images[0].data, PNG.toString("base64"));
  assert.equal(result.images[0].mimeType, "image/png");
  assert(!result.text.includes("\u2063"));
  assert.equal(registry.collapse(result.text), `compare ${a.token} and ${b.token}`);
  assert.equal(attachImages(registry, result.text, result.images).images.length, 2);
  assert.equal(attachImages(registry, "literal [Image #1]").images.length, 0);
  assert.equal(registry.addBuffers([PNG])[0].id, 3);
});

test("all-or-nothing imports, missing/corrupted snapshots, and limits", t => {
  const registry = new ImageRegistry(newImageState()); t.after(() => registry.dispose());
  assert.throws(() => registry.addBuffers([PNG, Buffer.from("not an image")]));
  assert.equal(registry.state.records.length, 0);
  assert.throws(() => registry.addBuffers([Buffer.alloc(MAX_IMAGE_BYTES + 1)]));
  const [a, b] = registry.addBuffers([PNG, PNG]);
  writeFileSync(b.path, Buffer.from("tampered"));
  assert.throws(() => registry.attachments(a.token + b.token), /Image #2.*快照内容已改变/);
  rmSync(a.path);
  assert.throws(() => registry.attachments(a.token), /Image #1/);
});

test("run-local state survives reconstructing registry without serializing images into session", t => {
  const state = newImageState(); const first = new ImageRegistry(state); t.after(() => first.dispose());
  const [record] = first.addBuffers([PNG]);
  const restored = new ImageRegistry(state);
  assert.equal(restored.collapse(record.wire), record.token);
  assert.deepEqual(restored.attachments(record.wire), first.attachments(record.token));
  assert.equal(readFileSync(record.path).length, PNG.length);
});
