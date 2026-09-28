import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 50 * 1024 * 1024;
const TOKEN = /\[Image #\d+\]\u2063[\ufe00-\ufe0f]{32}\u2063/g;
const WIRE = /(\[Image #\d+\]) ("(?:[^"\\]|\\.)*")/g;
const SNAPSHOT_PATH = /^\/(?:[^/]+\/)*pi-image-placeholder-[A-Za-z0-9]{6}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpg|gif|webp)$/;

export function displayImagePaths(text: string): string {
  // Recognize our serialized snapshots without reading files or run-local state:
  // restored sessions can outlive both the registry and the temporary files.
  return text.replace(WIRE, (wire: string, label: string, quotedPath: string) => {
    try {
      return SNAPSHOT_PATH.test(JSON.parse(quotedPath)) ? label : wire;
    } catch { return wire; }
  });
}
export interface ImageAttachment {
  type: "image";
  data: string;
  mimeType: string;
}
export interface ImageRecord {
  id: number;
  label: string;
  token: string;
  wire: string;
  path: string;
  mime: string;
  hash: string;
  bytes: number;
}
export interface ImageState {
  directory?: string;
  nextId: number;
  records: ImageRecord[];
  draft?: string;
  history?: string[];
}
export function newImageState(): ImageState {
  return { nextId: 1, records: [] };
}
export function mimeOf(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return undefined;
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function readBounded(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("不是普通文件");
    if (stat.size > MAX_IMAGE_BYTES) throw new Error("单张图片超过 20 MiB");
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("读取期间文件发生变化，请重试");
    return buffer.subarray(0, length);
  } finally { closeSync(fd); }
}

/** Whole-input local file list, not a shell: no expansion, execution, or URL fetching. */
export function parseImagePaths(text: string, cwd: string): string[] | null {
  const trimmed = text.trim();
  if (!trimmed || /[\n\r\x00-\x1f]/.test(trimmed)) return null;
  const parts: string[] = [];
  let part = "", quote = "", escaped = false;
  for (const ch of trimmed) {
    if (escaped) { part += ch; escaped = false; continue; }
    if (ch === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = ""; else part += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (/\s/.test(ch)) { if (part) { parts.push(part); part = ""; } }
    else part += ch;
  }
  if (escaped || quote) return null;
  if (part) parts.push(part);
  if (!parts.length) return null;
  const paths: string[] = [];
  for (let value of parts) {
    if (value.startsWith("file://")) {
      try { value = fileURLToPath(value); } catch { return null; }
    }
    if (!/^(\/|~\/|\.\.?\/)/.test(value) || !/^\.(png|jpe?g|gif|webp)$/i.test(extname(value))) return null;
    paths.push(value.startsWith("~/") ? join(homedir(), value.slice(2)) : resolve(cwd, value));
  }
  return paths;
}

export interface ImageSpan { start: number; end: number; record: ImageRecord }
export class ImageRegistry {
  constructor(readonly state: ImageState) {}
  addPaths(paths: string[]): ImageRecord[] {
    const buffers: Buffer[] = [];
    let total = 0;
    for (const path of paths) {
      try {
        const bytes = readBounded(path);
        total += bytes.length;
        if (total > MAX_MESSAGE_BYTES) throw new Error("本次导入超过 50 MiB");
        buffers.push(bytes);
      } catch (error) { throw new Error(`无法导入 ${path}: ${String(error)}`); }
    }
    return this.addBuffers(buffers);
  }
  addBuffers(buffers: Buffer[]): ImageRecord[] {
    if (buffers.reduce((sum, b) => sum + b.length, 0) > MAX_MESSAGE_BYTES) throw new Error("本次导入超过 50 MiB");
    const types = buffers.map(bytes => {
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error("单张图片超过 20 MiB");
      const mime = mimeOf(bytes);
      if (!mime) throw new Error("不支持的图片内容（支持 PNG、JPEG、GIF、WebP）");
      return mime;
    });
    this.state.directory ??= mkdtempSync(join(tmpdir(), "pi-image-placeholder-"));
    const added: ImageRecord[] = [];
    try {
      for (const [i, bytes] of buffers.entries()) {
        const id = this.state.nextId++;
        const label = `[Image #${id}]`;
        // Invisible identity distinguishes an object from literal '[Image #N]' text.
        // It is stripped from rendering and expanded before reaching pi's input hook.
        const secret = randomUUID().replaceAll("-", "");
        const suffix = "\u2063" + [...secret].map(c => String.fromCharCode(0xfe00 + parseInt(c, 16))).join("") + "\u2063";
        const mime = types[i];
        const path = join(this.state.directory, `${randomUUID()}.${mime === "image/jpeg" ? "jpg" : mime.slice(6)}`);
        writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
        added.push({ id, label, token: label + suffix, wire: `${label} ${JSON.stringify(path)}`, path, mime, hash: digest(bytes), bytes: bytes.length });
      }
    } catch (error) {
      for (const record of added) rmSync(record.path, { force: true });
      throw error;
    }
    this.state.records.push(...added);
    return added;
  }
  spans(text: string, kind: "token" | "wire" | "both" = "token"): ImageSpan[] {
    const lookup = new Map<string, ImageRecord>();
    for (const record of this.state.records) {
      if (kind !== "wire") lookup.set(record.token, record);
      if (kind !== "token") lookup.set(record.wire, record);
    }
    const matches = [...(kind !== "wire" ? text.matchAll(TOKEN) : []), ...(kind !== "token" ? text.matchAll(WIRE) : [])];
    return matches.flatMap(match => {
      const record = lookup.get(match[0]);
      return record ? [{ start: match.index!, end: match.index! + match[0].length, record }] : [];
    }).sort((a, b) => a.start - b.start);
  }
  private replace(text: string, kind: "token" | "wire", value: (record: ImageRecord) => string): string {
    for (const span of this.spans(text, kind).reverse()) text = text.slice(0, span.start) + value(span.record) + text.slice(span.end);
    return text;
  }
  expand(text: string): string { return this.replace(text, "token", record => record.wire); }
  collapse(text: string): string { return this.replace(text, "wire", record => record.token); }
  display(text: string): string {
    for (const record of this.state.records) text = text.replaceAll(record.token.slice(record.label.length), "");
    return text;
  }
  attachments(text: string): ImageAttachment[] {
    const spans = this.spans(text, "both");
    if (spans.reduce((sum, { record }) => sum + record.bytes, 0) > MAX_MESSAGE_BYTES) throw new Error("消息图片总量超过 50 MiB");
    return spans.map(({ record }) => {
      try {
        const bytes = readBounded(record.path);
        if (digest(bytes) !== record.hash) throw new Error("快照内容已改变");
        return { type: "image", mimeType: record.mime, data: bytes.toString("base64") };
      } catch (error) { throw new Error(`${record.label} 不可用：${String(error)}`); }
    });
  }
  dispose(): void {
    if (this.state.directory) rmSync(this.state.directory, { recursive: true, force: true });
  }
}
