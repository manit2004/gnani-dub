"""Thin client for the Gnani speech APIs: voice cloning and TTS."""

import os
import time
from pathlib import Path

import requests

API = "https://api.vachana.ai"
WAV_44K = {
    "sample_rate": 44100,
    "num_channels": 1,
    "sample_width": 2,
    "encoding": "linear_pcm",
    "container": "wav",
}


ENV_FILE = Path(__file__).parents[2] / ".env"  # server/.env


def load_key(name="GNANI_KEY"):
    """Read an API key from the environment, falling back to server/.env."""
    if key := os.environ.get(name):
        return key
    path = ENV_FILE
    if path.exists():
        for line in path.read_text().splitlines():
            if line.startswith(f"{name}="):
                return line.split("=", 1)[1].strip().strip("\"'")
    raise SystemExit(f"{name} not set; add it to server/.env (see .env.example)")


def _request(method, url, key=None, attempts=5, session=None, **kwargs):
    """HTTP call that retries rate limits (429), gateway errors (5xx) and dropped connections
    with backoff."""
    headers = kwargs.pop("headers", {})
    if key:
        headers["X-API-Key-ID"] = key
    for attempt in range(1, attempts + 1):
        try:
            r = (session or requests).request(method, url, headers=headers, **kwargs)
        except requests.ConnectionError:
            if attempt == attempts:
                raise
            reason, wait = "connection failed", 3 * attempt
        else:
            if r.status_code != 429 and r.status_code < 500:
                return r
            if attempt == attempts:
                break
            reason, wait = r.status_code, float(r.headers.get("Retry-After") or 2 * attempt)
        print(f"  {reason} for {url.removeprefix(API)}, retrying in {wait:.0f}s")
        time.sleep(wait)
    return r


def voice_embedding(key, wav):
    """Create a speaker embedding from 5-30 s of clean reference speech."""
    r = _request(
        "POST",
        f"{API}/api/v1/tts/voice-clone/embeddings",
        key,
        files={"audio_file": (Path(wav).name, Path(wav).read_bytes(), "audio/wav")},
        timeout=120,
    )
    r.raise_for_status()
    body = r.json()
    # The API reference nests it under data.voice_clone_embedding; the quick start shows it flat.
    emb = body.get("data", {}).get("voice_clone_embedding") or body
    return {k: emb[k] for k in ("embedding", "shape", "dtype")}


def synthesize_cloned(key, text, embedding):
    """Speak `text` in a cloned voice. Returns 44.1 kHz WAV bytes."""
    return _synthesize(
        key, {"text": text, "model": "vachana-vc-v1", "speaker_embedding": embedding}
    )


def synthesize_stock(key, text, language, voice="Shivani"):
    """Speak `text` in a stock Timbre v3.0 voice (every v3.0 voice speaks all 10 languages)."""
    return _synthesize(
        key, {"text": text, "model": "timbre-v3.0", "voice": voice, "language": language}
    )


def _synthesize(key, body):
    r = _request(
        "POST",
        f"{API}/api/v1/tts/inference",
        key,
        headers={"Content-Type": "application/json"},
        json={**body, "audio_config": WAV_44K},
        timeout=180,
    )
    if r.status_code != 200:
        raise RuntimeError(f"synthesis failed ({r.status_code}): {r.text[:300]}")
    return r.content
