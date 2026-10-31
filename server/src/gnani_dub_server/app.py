"""Local relay for the gnani-dub Chrome extension: translate, speak and clone on request.

The extension does the timing in the browser; this keeps the API keys on the server and
caches everything in server/cache/, so replaying or seeking back costs no credits.

Run it with `uv run gnani-dub-server` from the server/ folder.

Videos without captions are dubbed by streaming their audio to Gnani speech-to-text through
the /api/live/listen WebSocket (see listen.py).

Only the extension may call these routes: they need an X-Gnani-Dub header (which a web page
can't send to another origin without a CORS preflight we don't answer), and requests from a
web page's origin are refused. Otherwise any site you visit could spend your credits.
"""

import argparse
import hashlib
import json
import tempfile
import threading
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response
from pydantic import BaseModel

from . import audio, gnani
from .listen import listen
from .translate import SOURCES, Translator

CACHE = Path(__file__).parents[2] / "cache"  # server/cache
LANGUAGES = {"hi-IN", "bn-IN", "ta-IN", "te-IN", "kn-IN", "ml-IN", "mr-IN", "gu-IN", "pa-IN"}  # Gnani TTS
REF_MIN_S = 5  # Gnani wants 5-30 s of reference speech to clone a voice
gnani_lock = threading.Lock()  # Gnani allows one active request per account
cache_lock = threading.Lock()  # translation requests can overlap
_translator = None


def extension_only(request: Request):
    origin = request.headers.get("origin")
    if request.headers.get("x-gnani-dub") != "1" or (origin and not origin.startswith("chrome-extension://")):
        raise HTTPException(403, "Only the gnani-dub extension can use this route")


router = APIRouter(prefix="/api/live", dependencies=[Depends(extension_only)])


class TranslateRequest(BaseModel):
    texts: list[str]
    source: str
    target: str


class SpeakRequest(BaseModel):
    text: str
    lang: str
    voice_id: str | None = None
    max_s: float | None = None  # speed the clip up (≤1.5×) to fit this slot


@router.post("/translate")
def translate(req: TranslateRequest):
    if req.target not in LANGUAGES:
        raise HTTPException(400, f"Unsupported target language {req.target}")
    if req.source == req.target:
        return {"translations": req.texts}
    if req.source not in SOURCES:
        raise HTTPException(400, f"Can't translate from {req.source}")

    cache_file = CACHE / "translations" / f"{req.source}_{req.target}.json"
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    with cache_lock:
        cache = json.loads(cache_file.read_text()) if cache_file.exists() else {}
    todo = list(dict.fromkeys(t for t in req.texts if t not in cache))
    if todo:
        global _translator
        _translator = _translator or Translator()
        try:
            new = dict(zip(todo, _translator.translate_sentences(todo, req.source, req.target)))
        except RuntimeError as e:
            raise HTTPException(502, str(e)) from e
        with cache_lock:
            cache = json.loads(cache_file.read_text()) if cache_file.exists() else {}
            cache.update(new)
            cache_file.write_text(json.dumps(cache, ensure_ascii=False, indent=2))
    return {"translations": [cache[t] for t in req.texts]}


@router.post("/speak")
def speak(req: SpeakRequest):
    """Speak `text` in a cloned voice (or a stock one) and return a WAV, fitted to `max_s`."""
    if req.lang not in LANGUAGES:
        raise HTTPException(400, f"Unsupported language {req.lang}")
    voice = _load_voice(req.voice_id) if req.voice_id else None
    key = hashlib.sha256(f"{req.lang}|{req.voice_id or 'stock'}|{req.text}".encode()).hexdigest()[:20]
    cache = CACHE / "clips" / f"{key}.wav"
    if not cache.exists():
        cache.parent.mkdir(parents=True, exist_ok=True)
        with gnani_lock:
            try:
                if voice:
                    data = gnani.synthesize_cloned(gnani.load_key(), req.text, voice["embedding"])
                else:
                    data = gnani.synthesize_stock(gnani.load_key(), req.text, req.lang)
            except RuntimeError as e:
                raise HTTPException(502, str(e)) from e
        cache.write_bytes(data)

    clip = audio.fit(audio.from_wav_bytes(cache.read_bytes()), req.max_s or 0)
    with tempfile.NamedTemporaryFile(suffix=".wav") as f:
        audio.save_wav(f.name, clip)
        return Response(Path(f.name).read_bytes(), media_type="audio/wav")


@router.post("/voice")
async def voice(request: Request):
    """Clone a voice from a WAV of the video's speech (sent as the request body)."""
    body = await request.body()
    voice_id = hashlib.sha256(body).hexdigest()[:16]
    path = CACHE / "voices" / f"{voice_id}.json"
    if path.exists():
        return {"voice_id": voice_id, "reference_s": json.loads(path.read_text())["reference_s"]}

    path.parent.mkdir(parents=True, exist_ok=True)
    ref = path.with_suffix(".wav")
    with tempfile.NamedTemporaryFile(suffix=".wav") as f:
        f.write(body)
        f.flush()
        try:
            audio.extract_audio(f.name, ref, audio.RATE)
        except Exception as e:
            raise HTTPException(400, "Couldn't read the reference audio") from e
    seconds = audio.duration(ref)
    if seconds < REF_MIN_S:
        ref.unlink()
        raise HTTPException(400, f"Need at least {REF_MIN_S} s of speech to clone, got {seconds:.1f} s")
    with gnani_lock:
        try:
            embedding = gnani.voice_embedding(gnani.load_key(), ref)
        except Exception as e:
            raise HTTPException(502, f"Voice cloning failed: {e}") from e
    path.write_text(json.dumps({"embedding": embedding, "reference_s": round(seconds, 1)}))
    return {"voice_id": voice_id, "reference_s": round(seconds, 1)}


def _load_voice(voice_id):
    path = CACHE / "voices" / f"{Path(voice_id).name}.json"
    if not path.exists():
        raise HTTPException(404, "Unknown voice; clone it again")
    return json.loads(path.read_text())


app = FastAPI(title="gnani-dub-server")
app.include_router(router)
app.add_api_websocket_route("/api/live/listen", listen)  # checks the origin itself: no custom headers on a WebSocket


def main():
    parser = argparse.ArgumentParser(prog="gnani-dub-server", description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port)
