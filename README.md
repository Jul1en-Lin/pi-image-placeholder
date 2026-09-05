# pi-image-placeholder

为 **pi 0.85.0 / macOS / Ghostty / `--tui-mode fullscreen`** 提供 `[Image #N]` 图片占位符。独立 pi 扩展，不修改 pi 安装包或全局原型。已测试与本机 **pi-zentui 0.22.3** 组合。

## 安装

发布到 npm 后，推荐：

```sh
pi install npm:pi-image-placeholder
```

从 GitHub 直接安装：

```sh
pi install git:github.com/Jul1en-Lin/pi-image-placeholder
```

本地开发安装：

```sh
cd ~/prj/pi-image-placeholder
npm ci --ignore-scripts
pi install "$PWD"
```

在 pi 中执行 `/reload`。用 `/image-placeholder-status` 检查是否启用。必须关闭 `/settings` 中的 **Block images**；插件不会绕过屏蔽设置。全局设置对应 `images.blockImages: false`，也会允许其他来源（例如 read 工具）的图片进入模型。

卸载：`pi remove ~/prj/pi-image-placeholder`，然后 `/reload` 或重启。

## 使用

- **Ctrl+V**：读取剪贴板图片；没有图片时粘贴普通文字。
- **Finder 拖图**：支持本地 PNG、JPEG、GIF、WebP，一次可拖多张；支持带空格、中文、引号/反斜杠转义的路径和本地 `file://` URL。
- 左右键跨过整个占位符，Backspace/Delete 整块删除。原生撤销（macOS 默认 Ctrl+-）恢复图片对象；Ctrl+W/Ctrl+Y 的内部剪切/粘回保留绑定。
- ↑ 历史编辑、排队消息取回、`/reload` 后的本次运行草稿重新显示占位符。
- 编号按当前会话递增；删除不重排、不复用。手工输入 `[Image #1]` 只是普通文字。
- 粘贴/拖入时保存私有快照；原图后来被覆盖、移动或删除不影响已导入的图片。
- Enter 和 Alt+Enter 提交均验证图片。快照缺失、被改动、图片屏蔽或不支持图片的模型会阻止提交并保留草稿。导入失败时，重新导入，或按 Esc 明确确认后继续。

剪贴板读取期间暂存按键，读取完成后按顺序处理，避免快速输入/Enter 丢失或早于图片提交。Esc/Ctrl+C 可取消；超时为 5 秒。

## 发送与隐私

pi 0.85.0 的核心 Ctrl+V 仅插入临时路径，并不自动将普通路径文字转换成图片附件。本扩展在提交时将对象展开为 `[Image #N] "快照路径"`，在 `input` 钩子里附加标准 `{ type: "image", data, mimeType }` 内容，再交由 pi 原有模型请求流程发送。模型无需调用 read 才能看到图片。

聊天记录沿用 pi 原生文本/图片展示，因此发送后可能显示快照路径；本扩展只保证编辑框里的紧凑显示。提交内容不包含内部不可见身份标记。截图原始字节作为附件提交，不另行缩放；模型/服务商自身的图片限制仍然适用。

- 快照目录在系统临时目录，目录权限 `0700`、文件权限 `0600`。
- 删除占位符不立即删除快照，供撤销和历史使用；正常退出清理本进程自己的快照，绝不删除原图。
- `/reload` 所需状态仅存在进程内；不把未发送截图写入会话 JSONL。
- **跨重启草稿/旧图片重发不保证**。已发送图片仍按 pi 原有会话保存机制保存。
- 强制杀死进程/系统崩溃可能留下临时目录。不会自动删除其他进程或未知来源的文件。
- 不下载远程图片、不执行拖入的文本、不展开 shell 命令。普通输入中的图片路径不扫描；整个粘贴输入都是本地图片路径时才导入。终端将拖入与粘贴相同路径编码为相同输入时，二者无法区分。

资源限制：单张 20 MiB，一次导入/单条消息图片总量 50 MiB。大文件会报错，不静默省略。

## 编辑器兼容性

pi 0.85.0 没有公开的自定义原子片段 API。`src/editor-adapter.ts` 集中适配原生 Editor 实例的分段、光标边界、提交展开、粘贴及历史；保留原生布局、撤销、kill ring 和快捷键。对象在缓冲区中带不可见随机身份，显示时移除；普通字面占位符没有身份，不会意外附图。

扩展通过 `getEditorComponent` / `setEditorComponent` 包装已有工厂，在 `resources_discover`（所有 `session_start` 之后）接入。支持原生 CustomEditor、pi-zentui PolishedEditor 及其已验证的 base 包装结构。未知编辑器结构或非 0.85.0 版本会报错停用，不偷偷改用可拆分文字。其他插件若在运行中强行替换整个编辑器，需要重新 `/reload` 并确认状态。

目前不保证浏览器直接拖图、远程 SSH、其他系统/版本或将无括号拖入路径逐字节拆分传输的终端。Ghostty 实际键盘/拖拽还需下面的人工验收；PTY 测试不是 Ghostty GUI 自动化。

## 验证

```sh
npm test
npm run typecheck
python3 test/tui-smoke.py
```

单元测试直接运行 pi 0.85.0 编辑器，不用自制编辑器替身。PTY 测试启动已安装的 pi，使用隔离设置和输入拦截器验证实际图片附件，不访问模型、不改变用户剪贴板；若找到本机 pi-zentui，会再跑一次组合测试。可用 `ZENTUI_PATH` 指定其 `index.ts`。

`@earendil-works/pi-server` 是开发测试依赖，用于补足 0.85.0 非 bundle 入口的模块引用；运行扩展不依赖它。

人工验收：

1. 在 Ghostty 启动 `pi --tui-mode fullscreen`，截图复制到剪贴板，Ctrl+V，应显示 `[Image #1]`。
2. Finder 拖入两张图片（包括中文/空格文件名），验证编号、左右跨过、整块删除、撤销。
3. 加一句“描述这几张图”并发送，确认模型看到实际图像；这一步会调用你的模型。
4. ↑ 重新编辑、模型回复时 Alt+Enter 排队/Alt+Up 取回，确认仍显示占位符且图片数量正确。
5. 有草稿时通过扩展/API触发重载，或发送后执行 `/reload` 再 ↑，确认本次运行绑定保留。
6. 重新开启 Block images 后尝试发送图片，应报错并保留草稿。
