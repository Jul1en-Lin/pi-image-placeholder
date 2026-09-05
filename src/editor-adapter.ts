import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
type EditorComponent = ReturnType<NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>>;
import type { ImageRegistry } from "./images.ts";
import { parseImagePaths } from "./images.ts";

/** The only version-sensitive seam. These are instance hooks, never prototype patches. */
interface Editor085 {
  state: { lines: string[]; cursorLine: number; cursorCol: number };
  history: string[];
  isInPaste: boolean;
  segment(text: string, mode: string): Iterable<Intl.SegmentData>;
  expandPasteMarkers(text: string): string;
  handlePaste(text: string): void;
  submitValue(): void;
  setCursorCol(col: number): void;
  setText(text: string): void;
  addToHistory(text: string): void;
  insertTextAtCursor(text: string): void;
  getText(): string;
  getExpandedText(): string;
  onPasteImage?: () => void;
}
export interface ClipboardReader {
  (): Promise<{ image: Buffer } | { text: string }>;
}
export interface AdapterOptions {
  registry: ImageRegistry;
  cwd: string;
  notify(message: string): void;
  render(): void;
  readClipboard: ClipboardReader;
  validate(text: string): void;
  isSubmit(data: string): boolean;
  isCancel(data: string): boolean;
}
export interface ImageEditor {
  component: EditorComponent;
  snapshot(): { draft: string; history: string[] };
  stop(): void;
}

function findCore(component: unknown): Editor085 {
  let candidate = component as Record<string, unknown>;
  for (let depth = 0; depth < 4 && candidate; depth++) {
    if (["segment", "expandPasteMarkers", "handlePaste", "submitValue", "setCursorCol", "setText", "addToHistory", "insertTextAtCursor", "getText", "getExpandedText"].every(name => typeof candidate[name] === "function") &&
        candidate.state && Array.isArray((candidate.state as Editor085["state"]).lines) && Array.isArray(candidate.history)) return candidate as unknown as Editor085;
    candidate = candidate.base as Record<string, unknown>;
  }
  throw new Error("当前自定义编辑器不兼容 pi 0.85.0 原子片段适配；未替换编辑器。");
}

export function installImageEditor(component: EditorComponent, options: AdapterOptions): ImageEditor {
  const core = findCore(component);
  const { registry } = options;
  const segment = core.segment.bind(core);
  const expand = core.expandPasteMarkers.bind(core);
  const paste = core.handlePaste.bind(core);
  const setText = core.setText.bind(core);
  const history = core.addToHistory.bind(core);
  const insert = core.insertTextAtCursor.bind(core);
  const submit = core.submitValue.bind(core);
  const setCursor = core.setCursorCol.bind(core);
  const input = component.handleInput.bind(component);
  const render = component.render.bind(component);
  const mouse = component.handleMouse?.bind(component);
  let stopped = false;
  let pending = false;
  let generation = 0;
  let buffered: string[] = [];
  let importFailure: string | undefined;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const clearTimers = () => { for (const timer of timers) clearTimeout(timer); timers.clear(); };
  const failedImport = (error: unknown) => {
    importFailure = `${String(error)}；图片未导入。重新导入，或按 Esc 确认后继续。`;
    options.notify(importFailure);
  };
  const validate = () => {
    if (importFailure) throw new Error(importFailure);
    options.validate(core.getExpandedText());
  };

  core.segment = (text, mode) => {
    const spans = registry.spans(text);
    if (!spans.length) return segment(text, mode);
    const result: Intl.SegmentData[] = [];
    let start = 0;
    const append = (end: number) => {
      for (const item of segment(text.slice(start, end), mode)) result.push({ ...item, index: item.index + start, input: text });
    };
    for (const span of spans) {
      append(span.start);
      result.push({ segment: text.slice(span.start, span.end), index: span.start, input: text, isWordLike: false });
      start = span.end;
    }
    append(text.length);
    return result;
  };
  // Word navigation and character-jump helpers can select a raw string offset.
  // Snap it before their callers use it as a deletion/insertion boundary.
  core.setCursorCol = col => {
    const line = core.state.lines[core.state.cursorLine] ?? "";
    for (const span of registry.spans(line)) {
      if (col > span.start && col < span.end) {
        col = col > core.state.cursorCol ? span.end : span.start;
        break;
      }
    }
    setCursor(col);
  };
  const snap = () => {
    const line = core.state.lines[core.state.cursorLine] ?? "";
    const span = registry.spans(line).find(s => core.state.cursorCol > s.start && core.state.cursorCol < s.end);
    if (span) setCursor(span.start);
  };
  core.expandPasteMarkers = text => registry.expand(expand(text));
  core.setText = text => {
    if (!text) importFailure = undefined;
    setText(registry.collapse(text));
  };
  core.addToHistory = text => history(registry.collapse(text));

  const importPaths = (text: string): boolean => {
    const paths = parseImagePaths(text, options.cwd);
    if (!paths) return false;
    insertRecords(registry.addPaths(paths).map(r => r.token));
    importFailure = undefined;
    return true;
  };
  const insertRecords = (tokens: string[]) => {
    const { cursorLine, cursorCol, lines } = core.state;
    const line = lines[cursorLine] ?? "";
    const before = cursorCol > 0 && !/\s/.test(line[cursorCol - 1]) ? " " : "";
    const after = cursorCol < line.length && !/\s/.test(line[cursorCol]) ? " " : "";
    insert(before + tokens.join(" ") + after);
    options.render();
  };
  core.handlePaste = text => {
    try { if (!importPaths(text)) paste(text); }
    catch (error) { failedImport(error); }
  };
  // Programmatic text insertion remains text; our explicit clipboard handler owns image capture.
  core.insertTextAtCursor = text => insert(text);
  core.submitValue = () => {
    try {
      if (pending) throw new Error("剪贴板仍在读取，请稍候");
      validate();
      submit();
    } catch (error) { options.notify(String(error)); }
  };
  component.render = width => render(width).map(line => registry.display(line));
  component.handleInput = data => {
    if (stopped) return;
    if (options.isCancel(data)) importFailure = undefined;
    if (pending) {
      if (options.isCancel(data)) {
        generation++;
        clearTimers();
        pending = false;
        const saved = buffered;
        buffered = [];
        for (const item of saved) if (!options.isSubmit(item)) component.handleInput(item);
        input(data);
      } else buffered.push(data);
      return;
    }
    // Finder can emit an unbracketed whole path list. Never scan ordinary typed prose.
    if (!core.isInPaste && !data.includes("\x1b") && data.length > 1) {
      try { if (importPaths(data)) return; }
      catch (error) { failedImport(error); return; }
    }
    if (options.isSubmit(data)) {
      try { validate(); }
      catch (error) { options.notify(String(error)); return; }
    }
    input(data);
    snap();
  };
  if (mouse) component.handleMouse = event => {
    if (pending) return { handled: true };
    const result = mouse(event);
    snap();
    return result;
  };
  core.onPasteImage = () => {
    pending = true;
    const ticket = ++generation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("读取剪贴板超时（5 秒）")), 5000);
      timers.add(timer);
    });
    void Promise.race([options.readClipboard(), timeout]).then(value => {
      if (stopped || ticket !== generation) return;
      if ("image" in value) {
        insertRecords(registry.addBuffers([value.image]).map(r => r.token));
        importFailure = undefined;
      } else if (value.text && !importPaths(value.text)) paste(value.text);
      pending = false;
      const saved = buffered;
      buffered = [];
      for (const data of saved) component.handleInput(data);
      options.render();
    }).catch(error => {
      if (stopped || ticket !== generation) return;
      pending = false;
      failedImport(error);
      const saved = buffered;
      buffered = [];
      for (const data of saved) if (!options.isSubmit(data)) component.handleInput(data);
      options.render();
    }).finally(() => { clearTimeout(timer); if (timer) timers.delete(timer); });
  };
  if (registry.state.history) core.history = registry.state.history.map(text => registry.collapse(text));
  return {
    component,
    snapshot: () => ({ draft: core.getExpandedText(), history: core.history.map(text => registry.expand(expand(text))) }),
    stop: () => { stopped = true; generation++; buffered = []; clearTimers(); },
  };
}
