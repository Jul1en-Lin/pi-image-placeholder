import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { ImageRegistry, newImageState } from "../src/images.ts";
import { installImageEditor, type AdapterOptions } from "../src/editor-adapter.ts";

export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64");
export const identity = (text: string) => text;
export const theme = { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } };
export const tui = { terminal: { rows: 30, columns: 80 }, requestRender() {} } as unknown as TUI;
export function fixture(overrides: Partial<AdapterOptions> = {}) {
  const registry = overrides.registry ?? new ImageRegistry(newImageState());
  const kb = new KeybindingsManager();
  setKeybindings(kb);
  const base = new CustomEditor(tui, theme, kb);
  const errors: string[] = [], sent: string[] = [];
  const adapter = installImageEditor(base, {
    registry, cwd: process.cwd(), notify: text => errors.push(text), render() {},
    readClipboard: async () => ({ image: PNG }),
    validate: text => { registry.attachments(text); },
    isSubmit: data => kb.matches(data, "tui.input.submit") || kb.matches(data, "app.message.followUp"),
    isCancel: data => kb.matches(data, "app.interrupt") || kb.matches(data, "app.clear"),
    ...overrides,
  });
  base.onSubmit = text => { sent.push(text); base.addToHistory(text); };
  base.focused = true;
  base.render(80);
  return { base, adapter, registry, errors, sent, kb };
}
export async function tick() { await new Promise(resolve => setTimeout(resolve, 15)); }
