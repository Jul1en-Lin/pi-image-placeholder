import { CustomEditor, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ImageRegistry, newImageState, displayImagePaths, type ImageState, type ImageAttachment } from "./images.ts";
import { installImageEditor, type ImageEditor } from "./editor-adapter.ts";

interface ProcessState { sessions: Map<string, ImageState>; files: Map<string, string> }
const STATE_KEY = Symbol.for("pi-image-placeholder/v1");
function processState(): ProcessState {
  const root = globalThis as typeof globalThis & { [STATE_KEY]?: ProcessState };
  if (!root[STATE_KEY]) {
    const state: ProcessState = { sessions: new Map(), files: new Map() };
    root[STATE_KEY] = state;
    // Own snapshots only. Keep them across /reload, /new, /resume and /fork until exit.
    process.once("exit", () => {
      for (const session of state.sessions.values()) {
        try { new ImageRegistry(session).dispose(); } catch { /* Exit cleanup is best effort. */ }
      }
    });
  }
  return root[STATE_KEY]!;
}

export function attachImages(registry: ImageRegistry, text: string, existing: ImageAttachment[] = []) {
  const wire = registry.expand(text);
  const added = registry.attachments(wire);
  // Idempotent if the same queued input passes the extension a second time.
  const present = new Set(existing.map(image => `${image.mimeType}:${image.data}`));
  return { text: wire, images: [...existing, ...added.filter(image => !present.has(`${image.mimeType}:${image.data}`))] };
}

export default function imagePlaceholders(pi: ExtensionAPI) {
  pi.registerMarkdownTransformer((markdown, { messageType }) =>
    messageType === "user" ? displayImagePaths(markdown) : markdown);

  let registry: ImageRegistry | undefined;
  let editor: ImageEditor | undefined;
  let context: ExtensionContext | undefined;
  let installed = false;
  let warned = false;

  const validate = (text: string) => {
    if (!registry || !context || !registry.spans(text, "both").length) return;
    if (text.trimStart().startsWith("!")) throw new Error("图片对象不能作为 shell 命令提交；请使用普通文件路径。");
    const settings = SettingsManager.create(context.cwd, undefined, { projectTrusted: context.isProjectTrusted() });
    if (settings.getBlockImages()) throw new Error("图片发送已屏蔽：请在 /settings 关闭 Block images 后重试。");
    if (!context.model?.input.includes("image")) throw new Error("当前模型未声明支持图片；请切换到多模态模型。");
    registry.attachments(text); // Verify every snapshot before pi clears the editor or queues input.
  };

  pi.on("session_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    context = ctx;
    installed = false;
    warned = false;
    const state = processState();
    const id = ctx.sessionManager.getSessionId();
    let session = state.sessions.get(id);
    if (!session) {
      session = newImageState();
      // Forked prompts may refer to existing run-local images. Preserve their IDs.
      if (event.reason === "fork" && event.previousSessionFile) {
        const parentId = state.files.get(event.previousSessionFile);
        const parent = parentId ? state.sessions.get(parentId) : undefined;
        session.records = [...(parent?.records ?? [])];
        session.nextId = parent?.nextId ?? 1;
      }
      state.sessions.set(id, session);
    }
    const file = ctx.sessionManager.getSessionFile();
    if (file) state.files.set(file, id);
    registry = new ImageRegistry(session);
  });

  // Runs after all session_start handlers, including pi-zentui's editor factory.
  pi.on("resources_discover", (_event, ctx) => {
    if (ctx.mode !== "tui" || !registry || installed) return;
    installed = true;
    if (process.platform !== "darwin") {
      ctx.ui.notify(`Image placeholders 未启用：当前仅支持 macOS（当前平台：${process.platform}）。`, "error");
      return;
    }
    const previous = ctx.ui.getEditorComponent();
    // pi's factory swap copies getText(), which loses native large-paste data.
    // Preserve the expanded draft before replacing the instance.
    const currentDraft = ctx.ui.getEditorText();
    const activeRegistry = registry;
    ctx.ui.setEditorComponent((tui, theme, kb) => {
      const base = previous?.(tui, theme, kb) ?? new CustomEditor(tui, theme, kb, { embedWorkingStatus: true });
      try {
        editor = installImageEditor(base, {
          registry: activeRegistry,
          cwd: ctx.cwd,
          notify: message => ctx.ui.notify(message, "error"),
          render: () => tui.requestRender(),
          validate,
          isSubmit: data => kb.matches(data, "tui.input.submit") || kb.matches(data, "app.message.followUp"),
          isCancel: data => kb.matches(data, "app.interrupt") || kb.matches(data, "app.clear"),
          readClipboard: async () => {
            const clipboard = await import("@mariozechner/clipboard");
            if (clipboard.hasImage()) return { image: Buffer.from(await clipboard.getImageBinary()) };
            return { text: clipboard.hasText() ? await clipboard.getText() : "" };
          },
        });
        return editor.component;
      } catch (error) {
        ctx.ui.notify(`Image placeholders 未启用：${String(error)}`, "error");
        return base;
      }
    });
    ctx.ui.setEditorText(activeRegistry.state.draft ?? currentDraft);
    activeRegistry.state.draft = undefined;
  });

  pi.on("input", (event, ctx) => {
    if (ctx.mode !== "tui" || event.source !== "interactive" || !registry) return;
    if (!registry.spans(event.text, "both").length) return;
    try {
      validate(event.text);
      return { action: "transform", ...attachImages(registry, event.text, event.images) };
    } catch (error) {
      // Validation normally runs before submit. This also catches changes between
      // editor preflight and input dispatch, including queued-message resubmission.
      const current = ctx.ui.getEditorText();
      ctx.ui.setEditorText(current ? `${current}\n${event.text}` : event.text);
      ctx.ui.notify(String(error), "error");
      return { action: "handled" };
    }
  });

  pi.on("session_shutdown", () => {
    if (editor && registry) Object.assign(registry.state, editor.snapshot());
    editor?.stop();
    editor = undefined;
    context = undefined;
  });

  pi.registerCommand("image-placeholder-status", {
    description: "查看图片占位符插件状态（不输出图片内容）",
    handler: async (_args, ctx) => {
      ctx.ui.notify(editor ? `Image placeholders：已启用，当前运行记录 ${registry?.state.records.length ?? 0} 张图片。` : "Image placeholders：当前编辑器未启用。", editor ? "info" : "warning");
    },
  });

  // Do not override policy at request time. Give feedback if image blocking was
  // re-enabled after a message had already entered pi's queue.
  pi.on("before_agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || !registry || warned) return;
    const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
    if (settings.getBlockImages() && registry.state.records.length) {
      warned = true;
      ctx.ui.notify("Block images 已开启：pi 会屏蔽图片内容，插件不会绕过。", "warning");
    }
  });
}
