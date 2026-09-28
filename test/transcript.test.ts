import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { initTheme, UserMessageComponent, type ExtensionAPI, type MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import imagePlaceholders, { attachImages } from "../src/index.ts";
import { displayImagePaths, ImageRegistry, newImageState } from "../src/images.ts";
import { PNG } from "./helpers.ts";

function registeredTransformer(): MarkdownTransformer {
  const transformers: MarkdownTransformer[] = [];
  imagePlaceholders({
    registerMarkdownTransformer: (transformer: MarkdownTransformer) => transformers.push(transformer),
    on() {},
    registerCommand() {},
  } as unknown as ExtensionAPI);
  assert.equal(transformers.length, 1);
  return transformers[0];
}

const snapshot = "/var/folders/example/T/pi-image-placeholder-7VeyLp/777f6069-0ce0-4160-9c60-00d522b896f5.png";
const wire = (path: string, id = 1) => `[Image #${id}] ${JSON.stringify(path)}`;

initTheme("dark");

function render(text: string, width: number, transformers: MarkdownTransformer[] = []): string[] {
  return new UserMessageComponent(text, undefined, 1, transformers).render(width).map(stripVTControlCharacters);
}

test("transcript compacts single and multiple snapshots while preserving surrounding Markdown", t => {
  const registry = new ImageRegistry(newImageState());
  t.after(() => registry.dispose());
  const [a, b] = registry.addBuffers([PNG, PNG]);
  const transform = registeredTransformer();
  for (const [text, expected] of [
    [a.wire, a.label],
    [`**对比** ${a.wire} 和 ${b.wire}\n下一行 /tmp/manual.png`, `**对比** ${a.label} 和 ${b.label}\n下一行 /tmp/manual.png`],
    [`${b.wire} ${a.wire} ${a.wire}`, `${b.label} ${a.label} ${a.label}`],
  ]) {
    assert.equal(displayImagePaths(text), expected);
    assert.equal(displayImagePaths(expected), expected);
    for (const width of [32, 80, 160]) {
      assert.deepEqual(render(text, width, [transform]), render(expected, width));
    }
  }
});

test("serialized snapshots display compactly across temp roots, escapes and image formats", () => {
  for (const extension of ["png", "jpg", "gif", "webp"]) {
    const path = snapshot.replace(/\.png$/, `.${extension}`);
    assert.equal(displayImagePaths(wire(path, 42)), "[Image #42]");
    const escapedRoot = path.replace("/var/folders/example/T", '/tmp/中文 root/quote" and back\\slash');
    assert.equal(displayImagePaths(wire(escapedRoot)), "[Image #1]");
  }
});

test("literal labels, ordinary paths and malformed or unrelated wire lookalikes are unchanged", () => {
  const unchanged = [
    "literal [Image #1]",
    JSON.stringify(snapshot),
    `原图：${snapshot}`,
    wire("/tmp/photo.png"),
    wire(snapshot.replace("pi-image-placeholder-", "other-plugin-")),
    wire(snapshot.replace("7VeyLp", "manual-directory")),
    wire(snapshot.replace("777f6069-0ce0-4160-9c60-00d522b896f5", "photo")),
    wire(snapshot.replace(".png", ".txt")),
    wire(snapshot.slice(1)),
    '[Image #1] "/tmp/bad\\q.png"',
    '[Image #1] "unterminated',
    '[Image #1] "/tmp/new\nline.png"',
    '[Image #1] /tmp/unquoted.png',
    '`/tmp/manual.png` and **[Image #2]**',
  ];
  for (const text of unchanged) assert.equal(displayImagePaths(text), text);
});

test("the registered display transformer only changes user messages", () => {
  const transform = registeredTransformer();
  const text = wire(snapshot);
  for (const messageType of ["assistant", "assistant-thinking"] as const) {
    for (const isStreaming of [true, false]) {
      assert.equal(transform(text, { messageType, isStreaming, availableWidth: 80 }), text);
    }
  }
  assert.equal(transform(text, { messageType: "user", isStreaming: false, availableWidth: 80 }), "[Image #1]");
});

test("display and a fresh extension leave serialized model text and attachment bytes untouched", t => {
  const registry = new ImageRegistry(newImageState());
  t.after(() => registry.dispose());
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  const [a, b] = registry.addBuffers([PNG, gif]);
  const payload = attachImages(registry, `看看 ${a.token} 和 ${b.token}`);
  const saved = JSON.stringify(payload);
  const expected = `看看 ${a.label} 和 ${b.label}`;
  assert.equal(payload.text, `看看 ${a.wire} 和 ${b.wire}`);
  assert.deepEqual(payload.images, [
    { type: "image", mimeType: "image/png", data: PNG.toString("base64") },
    { type: "image", mimeType: "image/gif", data: gif.toString("base64") },
  ]);
  assert.deepEqual(render(payload.text, 80, [registeredTransformer()]), render(expected, 80));
  assert.equal(JSON.stringify(payload), saved);

  registry.dispose();
  const restored = JSON.parse(saved);
  // No session_start and no registry: only the saved message reaches this new renderer.
  assert.deepEqual(render(restored.text, 80, [registeredTransformer()]), render(expected, 80));
  assert.equal(JSON.stringify(restored), saved);
});
