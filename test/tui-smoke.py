#!/usr/bin/env python3
"""Exercise installed pi in isolated PTYs: editor/sink and offline chat/session replay.
Optionally tests installed pi-zentui.
"""
import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[1]
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP8z4AdMOEQH6QSAM1BAQ/oQeJvAAAAAElFTkSuQmCC')
SINK = r'''
import { appendFileSync, readFileSync } from "node:fs";
export default function(pi) {
  const report = process.env.IMAGE_TEST_REPORT;
  pi.on("resources_discover", (_event, ctx) => {
    appendFileSync(report, JSON.stringify({ready: true, model: ctx.model?.id}) + "\n");
  });
  pi.on("input", (event) => {
    appendFileSync(report, JSON.stringify({text: event.text, images: event.images?.map(i => ({mimeType: i.mimeType, data: i.data})), source: event.source}) + "\n");
    return {action: "handled"};
  });
  pi.registerCommand("test-reload-draft", { handler: async (_args, ctx) => {
    const entries = readFileSync(report, "utf8").trim().split("\n").map(JSON.parse);
    ctx.ui.setEditorText(entries.filter(e => e.text).at(-1).text);
    await ctx.reload();
  }});
}
'''
FAKE_PROVIDER = r'''
import { appendFileSync } from "node:fs";
const { createAssistantMessageEventStream } = await import(process.env.IMAGE_TEST_AI_URL);
export default function(pi) {
  pi.registerProvider("image-test-offline", {
    baseUrl: "http://localhost:0",
    apiKey: "offline-only",
    api: "image-test-offline-api",
    models: [{ id: "image-test", name: "Offline image test", reasoning: false,
      input: ["text", "image"], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
      contextWindow: 8192, maxTokens: 512 }],
    streamSimple(model, context) {
      const users = context.messages.filter(message => message.role === "user");
      appendFileSync(process.env.IMAGE_TEST_REPORT, JSON.stringify({ provider: true,
        users: users.map(message => message.content) }) + "\n");
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
        const partial = { role: "assistant", api: model.api, provider: model.provider,
          model: model.id, content: [], usage, stopReason: "pending", timestamp: Date.now() };
        stream.push({ type: "start", partial });
        const text = "offline response complete";
        partial.content = [{ type: "text", text: "" }];
        stream.push({ type: "text_start", contentIndex: 0, partial });
        partial.content[0].text = text;
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
        const done = { ...partial, stopReason: "stop" };
        stream.push({ type: "done", reason: "stop", message: done });
        stream.end(done);
      });
      return stream;
    }
  });
}
'''


def run(zentui=None):
    with tempfile.TemporaryDirectory(prefix="pi-image-smoke-") as folder:
        folder = Path(folder)
        agent = folder / "agent"
        agent.mkdir()
        (agent / "settings.json").write_text(json.dumps({"images": {"blockImages": False}, "enableInstallTelemetry": False, "lastChangelogVersion": "0.85.0"}))
        image = folder / "中文 image.png"
        image.write_bytes(PNG)
        sink = folder / "sink.ts"
        sink.write_text(SINK)
        report = folder / "report.jsonl"
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 100, 0, 0))
        command = [shutil.which("pi"), "--offline", "--no-session", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-extensions", "--tui-mode", "fullscreen", "--provider", "openai", "--model", "gpt-4o"]
        if zentui:
            command += ["-e", str(zentui)]
        command += ["-e", str(ROOT / "src/index.ts"), "-e", str(sink)]
        env = dict(os.environ, PI_CODING_AGENT_DIR=str(agent), IMAGE_TEST_REPORT=str(report), PI_OFFLINE="1", PI_TELEMETRY="0", TERM="xterm-256color")
        proc = subprocess.Popen(command, cwd=folder, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        output = bytearray()
        def drain(seconds=.3):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                if select.select([master], [], [], .05)[0]:
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        break
                    output.extend(data)
        def entries():
            return [json.loads(line) for line in report.read_text().splitlines()] if report.exists() else []
        def wait(predicate, seconds=20):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                drain(.1)
                if predicate(): return
                if proc.poll() is not None: break
            raise AssertionError(bytes(output[-12000:]).decode(errors="replace"))
        def send(text):
            os.write(master, text.encode())
            drain(.3)
        try:
            wait(lambda: any(e.get("ready") for e in entries()))
            # Allow startup's terminal-protocol query timeout to complete.
            drain(1.5)
            send('/image-placeholder-status\r')
            assert '已启用'.encode() in output, bytes(output[-5000:]).decode(errors='replace')
            output.clear()
            send('\x1b[200~' + json.dumps(str(image), ensure_ascii=False) + ' ' + json.dumps(str(image), ensure_ascii=False) + '\x1b[201~')
            assert b'[Image #1]' in output and b'[Image #2]' in output, bytes(output[-6000:]).decode(errors='replace')
            settings_file = agent / 'settings.json'
            settings = json.loads(settings_file.read_text())
            settings['images'] = {'blockImages': True}
            settings_file.write_text(json.dumps(settings))
            send('\r')
            assert not [e for e in entries() if 'text' in e], 'blocked images were submitted'
            assert '图片发送已屏蔽'.encode() in output
            settings['images'] = {'blockImages': False}
            settings_file.write_text(json.dumps(settings))
            send('\r')
            wait(lambda: len([e for e in entries() if 'text' in e]) == 1)
            captured = [e for e in entries() if 'text' in e][0]
            assert len(captured['images']) == 2, captured
            assert all(i['mimeType'] == 'image/png' and base64.b64decode(i['data']) == PNG for i in captured['images'])
            assert '\u2063' not in captured['text']
            # Rebuild extensions with a nonempty draft and verify binding recovery.
            send('/test-reload-draft\r')
            wait(lambda: sum(bool(e.get('ready')) for e in entries()) >= 2)
            drain(.5)
            send('\r')
            wait(lambda: len([e for e in entries() if 'text' in e]) == 2)
            second = [e for e in entries() if 'text' in e][1]
            assert second['text'] == captured['text'], second
            assert len(second['images']) == 2, second
            send('/quit\r')
            wait(lambda: proc.poll() is not None)
            # Snapshot paths must be removed; never remove the source file.
            for name in re.findall(r'\[Image #\d+\] ("[^"]+")', captured['text']):
                assert not Path(json.loads(name)).exists(), name
            assert image.read_bytes() == PNG
            print('PASS fullscreen PTY' + (' + pi-zentui' if zentui else '') + ': drag → atoms → image attachments; /reload draft; exit cleanup; no model request')
        finally:
            if proc.poll() is None:
                proc.terminate()
                try: proc.wait(timeout=4)
                except subprocess.TimeoutExpired: proc.kill(); proc.wait()
            os.close(master)


def run_chat():
    with tempfile.TemporaryDirectory(prefix='pi-image-chat-') as folder:
        folder = Path(folder)
        agent = folder / 'agent'
        agent.mkdir()
        (agent / 'settings.json').write_text(json.dumps({
            'images': {'blockImages': False}, 'enableInstallTelemetry': False,
            'lastChangelogVersion': '0.87.1'}))
        image = folder / '中文 image.png'
        image.write_bytes(PNG)
        provider = folder / 'fake-provider.ts'
        provider.write_text(FAKE_PROVIDER)
        report = folder / 'provider.jsonl'
        session_dir = folder / 'sessions'
        ai = ROOT / 'node_modules/@earendil-works/pi-ai/dist/index.js'
        assert ai.is_file(), ai
        env = dict(os.environ, PI_CODING_AGENT_DIR=str(agent),
                   IMAGE_TEST_AI_URL=ai.as_uri(), IMAGE_TEST_REPORT=str(report),
                   PI_OFFLINE='1', PI_TELEMETRY='0', TERM='xterm-256color')
        # Explicit extension/model and session storage: no user settings, credentials or network.
        command = [shutil.which('pi'), '--offline', '--no-context-files', '--no-skills',
                   '--no-prompt-templates', '--no-extensions', '--tui-mode', 'fullscreen',
                   '--session-dir', str(session_dir), '--provider', 'image-test-offline',
                   '--model', 'image-test', '-e', str(ROOT / 'src/index.ts'), '-e', str(provider)]

        def launch(extra=()):
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 100, 0, 0))
            proc = subprocess.Popen(command + list(extra), cwd=folder, env=env, stdin=slave,
                                    stdout=slave, stderr=slave, start_new_session=True)
            os.close(slave)
            output = bytearray()
            def drain(seconds=.2):
                deadline = time.monotonic() + seconds
                while time.monotonic() < deadline:
                    if select.select([master], [], [], .05)[0]:
                        try: output.extend(os.read(master, 65536))
                        except OSError: break
            def wait(predicate, seconds=20):
                deadline = time.monotonic() + seconds
                while time.monotonic() < deadline:
                    drain(.1)
                    if predicate(): return
                    if proc.poll() is not None: break
                raise AssertionError(bytes(output[-12000:]).decode(errors='replace'))
            def send(text):
                os.write(master, text.encode())
                drain(.3)
            def close():
                if proc.poll() is None:
                    proc.terminate()
                    try: proc.wait(timeout=4)
                    except subprocess.TimeoutExpired: proc.kill(); proc.wait()
                os.close(master)
            return proc, output, drain, wait, send, close

        def provider_entries():
            return [json.loads(line) for line in report.read_text().splitlines()] if report.exists() else []

        proc, output, drain, wait, send, close = launch()
        try:
            drain(2)
            assert proc.poll() is None, output.decode(errors='replace')
            send('\x1b[200~' + json.dumps(str(image), ensure_ascii=False) + '\x1b[201~')
            assert b'[Image #1]' in output, output[-6000:].decode(errors='replace')
            output.clear()  # Exclude editor rendering; check the actual submitted chat area.
            send('\r')
            wait(lambda: b'offline response complete' in output and len(provider_entries()) == 1)
            drain(.5)
            assert b'[Image #1]' in output, output[-6000:].decode(errors='replace')
            session_files = list(session_dir.rglob('*.jsonl'))
            assert len(session_files) == 1, session_files
            session = session_files[0]
            messages = [e['message'] for e in map(json.loads, session.read_text().splitlines())
                        if e.get('type') == 'message']
            users = [m for m in messages if m['role'] == 'user']
            assert len(users) == 1, users
            content = users[0]['content']
            text = content if isinstance(content, str) else next(b['text'] for b in content if b['type'] == 'text')
            paths = re.findall(r'\[Image #1\] ("[^"]+")', text)
            assert len(paths) == 1, text
            snapshot = json.loads(paths[0])
            assert re.fullmatch(r'pi-image-placeholder-[A-Za-z0-9]{6}', Path(snapshot).parent.name), snapshot
            assert Path(snapshot).is_absolute() and Path(snapshot).suffix == '.png', snapshot
            assert Path(snapshot).read_bytes() == PNG
            images = [b for b in content if b['type'] == 'image']
            assert len(images) == 1 and images[0]['mimeType'] == 'image/png', (content, provider_entries())
            assert base64.b64decode(images[0]['data']) == PNG
            seen = provider_entries()[0]['users']
            assert seen == [content], (seen, content)
            # A full path can wrap across terminal lines; check identifying fragments too.
            hidden_fragments = [snapshot, 'pi-image-placeholder-', Path(snapshot).stem[:8], Path(snapshot).stem[-12:]]
            for fragment in hidden_fragments:
                assert fragment.encode() not in output, output[-6000:].decode(errors='replace')
            assert any(m['role'] == 'assistant' and m.get('stopReason') == 'stop' for m in messages)
            send('/quit\r')
            wait(lambda: proc.poll() is not None)
        finally:
            close()

        assert not Path(snapshot).exists(), 'restored display must not depend on the snapshot file'
        proc, output, drain, wait, send, close = launch(['--session', str(session)])
        try:
            wait(lambda: b'offline response complete' in output)
            drain(.5)
            assert b'[Image #1]' in output, output[-6000:].decode(errors='replace')
            for fragment in hidden_fragments:
                assert fragment.encode() not in output, output[-6000:].decode(errors='replace')
            assert len(provider_entries()) == 1, 'restoring the session must not call the provider'
            assert image.read_bytes() == PNG
            send('/quit\r')
            wait(lambda: proc.poll() is not None)
            print('PASS fullscreen PTY chat: offline response; compact user message on send and fresh session restore; raw JSONL text/image preserved')
        finally:
            close()


if __name__ == '__main__':
    run()
    run_chat()
    zentui = Path(os.environ.get('ZENTUI_PATH', str(Path.home() / '.pi/agent/npm/node_modules/pi-zentui/extensions/zentui/index.ts')))
    if zentui.exists(): run(zentui)
    else: print('SKIP pi-zentui: set ZENTUI_PATH to its index.ts')
