#!/usr/bin/env python3
"""Exercise the installed pi in a PTY. An input sink prevents ALL model requests.
Runs isolated from user settings/sessions. Optionally tests installed pi-zentui.
"""
import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[1]
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==')
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
            import re
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


if __name__ == '__main__':
    run()
    zentui = Path(os.environ.get('ZENTUI_PATH', str(Path.home() / '.pi/agent/npm/node_modules/pi-zentui/extensions/zentui/index.ts')))
    if zentui.exists(): run(zentui)
    else: print('SKIP pi-zentui: set ZENTUI_PATH to its index.ts')
