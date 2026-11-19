"""Jarvis on-demand voice worker: one local speech model in a short-lived process.

    python voice_worker.py stt   # listening: faster-whisper (CPU, int8)
    python voice_worker.py tts   # speaking:  Kokoro

Run with the Python that has OpenJarvis's speech packages (the local setup's venv). It binds
127.0.0.1 on a free port, prints {"port": N} on stdout, loads its model on the first request, and
EXITS after JARVIS_VOICE_IDLE_SEC seconds without requests. Exiting is the only way to hand the
model's memory (Kokoro + PyTorch is ~1 GB) back to the operating system - so between conversations
all of that RAM belongs to the local LLM instead.

Settings (environment): JARVIS_VOICE_IDLE_SEC (default 120), JARVIS_WHISPER_MODEL (default "small"),
JARVIS_VOICE (default "bm_george"). Only the Python standard library plus the speech packages.
"""

import io
import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

MODE = sys.argv[1] if len(sys.argv) > 1 else "stt"
IDLE_SEC = float(os.environ.get("JARVIS_VOICE_IDLE_SEC", "120"))
WHISPER_MODEL = os.environ.get("JARVIS_WHISPER_MODEL", "small")
DEFAULT_VOICE = os.environ.get("JARVIS_VOICE", "bm_george")

_lock = threading.Lock()
_model = None
_pipelines = {}
_last = time.monotonic()
_busy = 0


def _touch():
    global _last
    _last = time.monotonic()


def _whisper():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        _model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
    return _model


def _kokoro(lang_code):
    global _model
    from kokoro import KModel, KPipeline

    if _model is None:
        _model = KModel(repo_id="hexgrad/Kokoro-82M").eval()
    if lang_code not in _pipelines:
        _pipelines[lang_code] = KPipeline(lang_code=lang_code, repo_id="hexgrad/Kokoro-82M", model=_model)
    return _pipelines[lang_code]


def transcribe(audio, ext, language):
    model = _whisper()
    tmp = tempfile.NamedTemporaryFile(suffix="." + ext, delete=False)
    try:
        with tmp:
            tmp.write(audio)
        kwargs = {"language": language} if language else {}
        segments, info = model.transcribe(tmp.name, vad_filter=True, **kwargs)
        text = " ".join(s.text.strip() for s in segments).strip()
        return {"text": text, "language": getattr(info, "language", None)}
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


def synthesize(text, voice, speed):
    import numpy as np
    import soundfile as sf

    voice = voice or DEFAULT_VOICE
    lang = voice[0] if voice[:1] in ("a", "b") else "a"
    pipeline = _kokoro(lang)
    chunks = [audio for _, _, audio in pipeline(text, voice=voice, speed=speed or 1.0) if audio is not None]
    if not chunks:
        raise RuntimeError("Kokoro produced no audio")
    data = np.concatenate([c.numpy() if hasattr(c, "numpy") else c for c in chunks])
    buf = io.BytesIO()
    sf.write(buf, data, 24000, format="WAV")
    return buf.getvalue(), voice


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # quiet
        pass

    def _send(self, code, body, ctype="application/json", headers=None):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        _touch()
        if self.path.startswith("/health"):
            return self._send(200, json.dumps({"mode": MODE, "loaded": _model is not None, "pid": os.getpid()}).encode())
        self._send(404, b"{}")

    def do_POST(self):
        global _busy
        _touch()
        _busy += 1
        try:
            url = urlparse(self.path)
            q = parse_qs(url.query)
            body = self.rfile.read(int(self.headers.get("content-length") or 0))
            with _lock:
                if MODE == "stt" and url.path == "/transcribe":
                    out = transcribe(body, (q.get("ext") or ["webm"])[0], (q.get("language") or [None])[0])
                    return self._send(200, json.dumps(out).encode())
                if MODE == "tts" and url.path == "/synthesize":
                    req = json.loads(body or b"{}")
                    wav, voice = synthesize(str(req.get("text", ""))[:4000], req.get("voice_id"), req.get("speed"))
                    return self._send(200, wav, "audio/wav", {"x-voice-id": voice})
            self._send(404, json.dumps({"error": "unknown route"}).encode())
        except Exception as exc:  # report, keep serving
            self._send(500, json.dumps({"error": str(exc)[:500]}).encode())
        finally:
            _busy -= 1
            _touch()


def _watchdog():
    while True:
        time.sleep(2)
        if _busy == 0 and time.monotonic() - _last > IDLE_SEC:
            os._exit(0)


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    print(json.dumps({"port": server.server_address[1], "mode": MODE, "pid": os.getpid()}), flush=True)
    threading.Thread(target=_watchdog, daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
