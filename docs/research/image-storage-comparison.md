# Coding agent 粘贴图片的落盘与会话保留

## 结论

“退出时清理临时快照”不等于“图片从未落盘”，也不等于“会话不保留图片”。常见实现会把**导入用的本地快照**与**会话记录中的输入**分开管理。会话可恢复，只能证明会话记录存在；除非文档或源码明确说明，不能据此断言原图字节也会写入、并能在重启后重新读取。

| 产品 | 粘贴时的本地文件 | 会话/重启 | 对图片字节能确认什么 |
|---|---|---|---|
| **OpenAI Codex CLI** | 官方 TUI 源码 `paste_image_to_temp_png()` 将剪贴板图写为 `codex-clipboard-*.png`，并调用 `tempfile` 的 `.keep()`（源码注释称文件会在句柄释放后保留）。源码中未见此路径的进程退出清理；系统临时目录自身的清理策略另当别论。 | `RolloutRecorder` 将会话条目写成 `~/.codex/sessions/` 下的 JSONL rollout，可供历史/恢复使用。 | `UserInput::LocalImage` 的源码注释明确说，发请求时会转换为含 base64 data URL 的 `Image`；会话协议也存有供 UI 重挂图片的本地路径。**但这些源码本身没有保证每种会话/恢复路径都会把所有图片字节持久化并可重新显示**；持久化会话不应直接等同于保证图片可复用。 |
| **Claude Code** | 官方 FAQ 确认可拖入图片或用 Ctrl+V 粘贴；公开官方资料没有说明 CLI 粘贴图片会写到哪个图片缓存路径、何时删除。 | 官方 CLI 文档支持 `--continue` / `--resume`，可恢复会话或指定 `.jsonl` transcript。Anthropic 数据使用文档称 Claude Code 客户端默认将明文 transcript 保存在 `~/.claude/projects/` 30 天。 | **只确认 transcript 本地保留及会话恢复；未找到官方说明确认 transcript 是否包含图片原始字节、引用或可恢复的本地图片文件。**闭源实现细节不作推断。 |
| **Gemini CLI** | 官方源码把剪贴板图写入项目临时目录的 `images/clipboard-<时间戳>.(png|jpg)`。`cleanupOldClipboardImages()` 的实现删除超过 1 小时的匹配文件；该代码说明了清理策略，但不据此推定清理具体发生时机。 | 官方会话文档称自动记录完整对话并支持恢复；默认会话保留 30 天，目录为 `~/.gemini/tmp/<project_hash>/chats/`。 | 会话记录的说明没有具体保证粘贴图片字节被保存或在恢复时可重新读取；故图片快照的短期清理策略与会话留存期限分开看。 |

## 与 pi-image-placeholder 的关系

本插件同样分成两层：`src/images.ts` 在系统临时目录创建私有快照，附件生成时再从快照读出 base64；`src/index.ts` 注册进程 `exit` 清理，只删除插件创建的快照。提交时插件把 `{ type: "image", data, mimeType }` 交给 pi 原生输入流程。因此，正常退出会清掉插件的**快照文件**，但不能据此说发送过的图片不会进入 pi 的会话记录；后者是 pi 原生会话持久化行为。未发送的快照状态不保证跨进程重启恢复。

所以本插件与其他 CLI 的相似点是“临时图片文件”和“可持久会话”可以并存；区别在清理策略：本插件正常退出即清理自有快照，Codex 的源码显式保留临时文件，Gemini 提供按年龄清理策略。关键表述应是：**导入快照会短暂落盘；发送后的图片是否、以何种形式保存在会话中，应按 pi 原生记录格式判断，不能从临时文件清理推导。**

## 官方证据

- Codex 源码：[`clipboard_paste.rs`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/clipboard_paste.rs)（`paste_image_to_temp_png` / `.keep()`）；[`user_input.rs`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/user_input.rs)（`UserInput::LocalImage` 注释）；[`protocol.rs`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)（`UserMessageEvent.local_images` 注释）；[`recorder.rs`](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs)（JSONL rollout）。
- Claude Code 官方资料： [User FAQ §2.7](https://support.claude.com/en/articles/14554922-claude-code-user-faq)（Ctrl+V / 拖入截图）；[CLI usage](https://docs.anthropic.com/en/docs/claude-code/cli-usage)（`--continue`、`--resume`）；[Data usage](https://docs.anthropic.com/en/docs/claude-code/data-usage)（本地明文 transcript、30 天）。
- Gemini CLI 官方资料：[`clipboardUtils.ts`](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/ui/utils/clipboardUtils.ts)（临时图片路径与一小时清理函数）；[Session management](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md)（自动会话记录、恢复与默认保留策略）。
- 本插件实现：[`src/images.ts`](../../src/images.ts)（创建快照、生成附件、删除快照）；[`src/index.ts`](../../src/index.ts)（pi 输入钩子与正常退出清理）。
