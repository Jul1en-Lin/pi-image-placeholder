import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, PNG, tick } from "./helpers.ts";

function assertNoFragment(text: string, tokens: string[]) {
  for (const token of tokens) text = text.replaceAll(token, "");
  assert(!/[\u2063\ufe00-\ufe0f]/.test(text), `partial image identity: ${JSON.stringify(text)}`);
}

test("deterministic mixed navigation/editing never leaves half an image object", t => {
  const f = fixture(); t.after(() => f.registry.dispose());
  const records = f.registry.addBuffers([PNG, PNG, PNG]);
  const tokens = records.map(r => r.token);
  let seed = 12345;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
  const keys = ["\x1b[D", "\x1b[C", "\x1b[A", "\x1b[B", "\x01", "\x05", "\x1b[1;5D", "\x1b[1;5C", "\x7f", "\x1b[3~", "\x17", "\x1bd", "\x15", "\x0b", "\x19", "\x1f", "中", "x", " ", "\x0a"];
  for (let round = 0; round < 20; round++) {
    f.base.setText(`中文 ${tokens[0]} test ${tokens[1]}\nfoo ${tokens[2]} end`);
    for (let step = 0; step < 100; step++) {
      f.base.render([12, 20, 40, 80][random() % 4]);
      f.base.handleInput(keys[random() % keys.length]);
      assertNoFragment(f.base.getText(), tokens);
      const { line, col } = f.base.getCursor();
      for (const span of f.registry.spans(f.base.getLines()[line] ?? "")) assert(col <= span.start || col >= span.end);
    }
  }
});

test("character jump cannot enter an image label, then deletion remains atomic", t => {
  const f = fixture(); t.after(() => f.registry.dispose());
  const [record] = f.registry.addBuffers([PNG]);
  f.base.setText(`a ${record.token} z`);
  f.base.handleInput("\x01"); f.base.handleInput("\x1d"); f.base.handleInput("m");
  const { col } = f.base.getCursor();
  assert(col === 2 || col === 2 + record.token.length);
  f.base.handleInput("\x7f");
  assertNoFragment(f.base.getText(), [record.token]);
});

test("failed import does not silently send remaining text, retry/escape resolves it", async t => {
  const f = fixture({ readClipboard: async () => ({ image: Buffer.from("invalid") }) });
  t.after(() => f.registry.dispose());
  f.base.setText("keep this draft");
  f.base.handleInput("\x16"); f.base.handleInput("\r"); await tick();
  assert.equal(f.sent.length, 0); assert.equal(f.base.getText(), "keep this draft");
  f.base.handleInput("\r"); assert.equal(f.sent.length, 0);
  f.base.handleInput("\x1b"); f.base.handleInput("\r"); assert.equal(f.sent.length, 1);
});

test("ordinary clipboard text and literal labels remain ordinary text", async t => {
  const f = fixture({ readClipboard: async () => ({ text: "literal [Image #1]" }) });
  t.after(() => f.registry.dispose());
  f.registry.addBuffers([PNG]);
  f.base.handleInput("\x16"); await tick();
  assert.equal(f.base.getText(), "literal [Image #1]");
  assert.equal(f.registry.attachments(f.base.getExpandedText()).length, 0);
});
