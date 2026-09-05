import assert from "node:assert/strict";
import { test } from "node:test";
import { rmSync } from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fixture, PNG, tick } from "./helpers.ts";

const left = "\x1b[D", right = "\x1b[C", backspace = "\x7f", del = "\x1b[3~", undo = "\x1f";
test("real pi editor: compact rendering, atomic arrows/delete and stable undo", t => {
  const f = fixture(); t.after(() => f.registry.dispose());
  const [a, b] = f.registry.addBuffers([PNG, PNG]);
  f.base.setText(a.token + b.token);
  f.base.handleInput(left); assert.equal(f.base.getCursor().col, a.token.length);
  f.base.handleInput(left); assert.equal(f.base.getCursor().col, 0);
  f.base.handleInput(right); assert.equal(f.base.getCursor().col, a.token.length);
  f.base.handleInput(backspace); assert.equal(f.base.getText(), b.token);
  f.base.handleInput(undo); assert.equal(f.base.getText(), a.token + b.token);
  f.base.handleInput(del); assert.equal(f.base.getText(), a.token);
  f.base.handleInput(undo); assert.equal(f.base.getText(), a.token + b.token);
  for (const width of [1, 5, 12, 20, 80]) {
    const rendered = f.base.render(width);
    for (const line of rendered) assert(visibleWidth(line) <= width, `${width}: ${line}`);
    assert(!rendered.join("").includes("\u2063"));
  }
  const display = f.base.render(80).join("\n");
  assert(display.includes("[Image #1]")); assert(display.includes("[Image #2]"));
  assert(!display.includes(f.registry.state.directory!));
});

test("word deletion + kill/yank, character jumps, multiline cursor and literal labels", t => {
  const f = fixture(); t.after(() => f.registry.dispose());
  const [a] = f.registry.addBuffers([PNG]);
  f.base.setText(a.token);
  f.base.handleInput("\x17"); assert.equal(f.base.getText(), ""); // Ctrl+W
  f.base.handleInput("\x19"); assert.equal(f.base.getText(), a.token); // Ctrl+Y
  f.base.handleInput("\x01"); // Ctrl+A
  f.base.handleInput("\x1bd"); assert.equal(f.base.getText(), ""); // Alt+D
  f.base.handleInput(undo); assert.equal(f.base.getText(), a.token);
  f.base.setText(`hello\n${a.token}\nworld`); f.base.render(40);
  f.base.handleInput("\x1b[A");
  const cursor = f.base.getCursor();
  assert(cursor.col === 0 || cursor.col === a.token.length);
  f.base.handleInput(backspace);
  assert(!f.base.getText().includes("[Image #1]") || f.base.getText().includes(a.token));
  f.base.setText("[Image #1]"); f.base.handleInput(backspace);
  assert.equal(f.base.getText(), "[Image #1");
  assert.equal(f.registry.attachments(f.base.getExpandedText()).length, 0);
});

test("submit expands before callback; history and dequeued text restore objects", t => {
  const f = fixture(); t.after(() => f.registry.dispose());
  const [a] = f.registry.addBuffers([PNG]);
  f.base.setText(a.token); f.base.handleInput("\r");
  assert.deepEqual(f.sent, [a.wire]); assert.equal(f.base.getText(), "");
  f.base.handleInput("\x1b[A"); assert.equal(f.base.getText(), a.token);
  f.base.setText(a.wire); assert.equal(f.base.getText(), a.token);
  const snapshot = f.adapter.snapshot(); f.adapter.stop();
  Object.assign(f.registry.state, snapshot);
  const restored = fixture({ registry: f.registry });
  restored.base.setText(snapshot.draft);
  assert.equal(restored.base.getText(), a.token);
  restored.base.setText(""); restored.base.handleInput("\x1b[A");
  assert.equal(restored.base.getText(), a.token);
});

test("missing image or blocked policy prevents clearing draft and submission", t => {
  const f = fixture(); t.after(() => f.registry.dispose());
  const [a] = f.registry.addBuffers([PNG]);
  f.base.setText(`hello ${a.token}`); rmSync(a.path);
  f.base.handleInput("\r");
  assert.equal(f.sent.length, 0); assert.equal(f.base.getText(), `hello ${a.token}`);
  assert(f.errors[0].includes("Image #1"));
  const blocked = fixture({ validate: text => { if (text) throw new Error("blocked"); } });
  t.after(() => blocked.registry.dispose());
  blocked.base.setText("draft"); blocked.base.handleInput("\x1b\r");
  assert.equal(blocked.base.getText(), "draft"); assert.equal(blocked.sent.length, 0);
});

test("Ctrl+V captures clipboard, preserves buffered typing and sends image-only prompt", async t => {
  let resolve!: (value: { image: Buffer }) => void;
  const f = fixture({ readClipboard: () => new Promise(r => { resolve = r; }) });
  t.after(() => f.registry.dispose());
  f.base.handleInput("\x16"); f.base.handleInput("x"); f.base.handleInput("\r");
  assert.equal(f.sent.length, 0);
  resolve({ image: PNG }); await tick();
  assert.equal(f.sent.length, 1); assert(f.sent[0].includes("[Image #1]")); assert(f.sent[0].endsWith("x"));
  assert.equal(f.registry.attachments(f.sent[0]).length, 1);
});

test("clipboard failure/cancel does not send or insert a delayed image", async t => {
  let reject!: (error: Error) => void;
  const f = fixture({ readClipboard: () => new Promise((_, r) => { reject = r; }) });
  t.after(() => f.registry.dispose());
  f.base.handleInput("\x16"); f.base.handleInput("x"); f.base.handleInput("\r");
  reject(new Error("clipboard denied")); await tick();
  assert.equal(f.sent.length, 0); assert.equal(f.base.getText(), "x");
  let resolve!: (value: { image: Buffer }) => void;
  const cancelled = fixture({ readClipboard: () => new Promise(r => { resolve = r; }) });
  t.after(() => cancelled.registry.dispose());
  cancelled.base.handleInput("\x16"); cancelled.base.handleInput("\x1b");
  resolve({ image: PNG }); await tick();
  assert.equal(cancelled.base.getText(), ""); assert.equal(cancelled.registry.state.records.length, 0);
});

test("bracketed multi-image drag, split paste chunks and ordinary large text paste", t => {
  const f = fixture(); t.after(() => f.registry.dispose());
  const [source] = f.registry.addBuffers([PNG]);
  const pathList = `${JSON.stringify(source.path)} ${JSON.stringify(source.path)}`;
  f.base.handleInput("\x1b[200~"); f.base.handleInput(pathList.slice(0, 17)); f.base.handleInput(pathList.slice(17)); f.base.handleInput("\x1b[201~");
  assert.equal(f.registry.spans(f.base.getText()).length, 2);
  assert(f.base.render(80).join("").includes("[Image #2]"));
  f.base.setText(""); f.base.handleInput(source.path);
  assert.equal(f.registry.spans(f.base.getText()).length, 1);
  const long = "ordinary prose\n".repeat(15);
  f.base.setText(""); f.base.handleInput(`\x1b[200~${long}\x1b[201~`);
  assert.equal(f.base.getExpandedText(), long);
});
