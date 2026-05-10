#!/usr/bin/env python3
"""Local bridge for the 感官刺客 shadow-lantern tab.

Run:
  python3 tools/shadow_lantern_bridge.py

The extension posts a pasted image data URL to http://127.0.0.1:8765/shadow-lantern.
This bridge saves it as a temporary image and asks Codex CLI to analyze it with the
shadow-lantern style-prompt workflow, then returns Markdown JSON.
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import tempfile
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "127.0.0.1"
PORT = 8765
MAX_BODY = 18 * 1024 * 1024
ROOT = Path(__file__).resolve().parents[1]
SKILL_PATH = Path.home() / ".agents" / "skills" / "shadow-lantern" / "SKILL.md"

PROMPT_TEMPLATE = """Use the local shadow-lantern skill to analyze the attached image.
反解颗粒度={granularity}

Return Markdown only. Follow the shadow-lantern output format exactly:
- Do not include a top-level heading.
- For 颗粒度 1, extract transferable visual style and abstract away subject matter.
- For 颗粒度 2, extract visual style plus detailed picture content, including a `### 画面内容` section.
- End with one unlabeled natural-language reusable prompt paragraph.
"""


def parse_data_url(value: str) -> tuple[str, bytes]:
    match = re.match(r"^data:(image/[a-zA-Z0-9.+-]+);base64,(.+)$", value or "", re.S)
    if not match:
        raise ValueError("imageDataUrl must be a base64 image data URL")
    mime, payload = match.groups()
    ext = {
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "image/avif": ".avif",
    }.get(mime.lower(), ".jpg")
    return ext, base64.b64decode(payload, validate=True)


def normalize_granularity(value: object) -> int:
    try:
        granularity = int(value)
    except (TypeError, ValueError):
        granularity = 1
    return 2 if granularity == 2 else 1


def run_codex(image_path: Path, granularity: int) -> str:
    skill_note = ""
    if SKILL_PATH.exists():
        skill_note = "\n\nLocal shadow-lantern skill instructions:\n" + SKILL_PATH.read_text(encoding="utf-8")
    prompt = PROMPT_TEMPLATE.format(granularity=granularity) + skill_note
    cmd = [
        "codex",
        "exec",
        "--cd",
        str(ROOT),
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--color",
        "never",
        "--image",
        str(image_path),
        "-",
    ]
    env = os.environ.copy()
    env.setdefault("NO_COLOR", "1")
    result = subprocess.run(
        cmd,
        cwd=str(ROOT),
        text=True,
        input=prompt,
        capture_output=True,
        timeout=180,
        env=env,
    )
    output = (result.stdout or "").strip()
    if result.returncode != 0:
        err = (result.stderr or output or f"codex exited {result.returncode}").strip()
        raise RuntimeError(err[-4000:])
    if not output:
        raise RuntimeError("codex returned empty output")
    return output


class Handler(BaseHTTPRequestHandler):
    server_version = "ShadowLanternBridge/1.0"

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.end_headers()

    def do_GET(self) -> None:
        if self.path == "/health":
            self.respond(200, {"ok": True, "service": "shadow-lantern"})
            return
        self.respond(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/shadow-lantern":
            self.respond(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_BODY:
                raise ValueError("request body is empty or too large")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            granularity = normalize_granularity(payload.get("granularity"))
            ext, image_bytes = parse_data_url(payload.get("imageDataUrl", ""))
            with tempfile.NamedTemporaryFile(prefix="shadow-lantern-", suffix=ext, delete=False) as tmp:
                tmp.write(image_bytes)
                tmp_path = Path(tmp.name)
            try:
                markdown = run_codex(tmp_path, granularity)
            finally:
                tmp_path.unlink(missing_ok=True)
            self.respond(200, {"markdown": markdown})
        except Exception as exc:
            traceback.print_exc()
            self.respond(500, {"error": str(exc)})

    def respond(self, status: int, data: dict) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"shadow-lantern bridge listening on http://{HOST}:{PORT}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
