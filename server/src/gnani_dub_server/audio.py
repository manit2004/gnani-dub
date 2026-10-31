"""ffmpeg and PCM helpers. Audio is handled as mono float32 numpy arrays."""

import io
import subprocess
import wave

import numpy as np

RATE = 44100
MAX_SPEEDUP = 1.5  # beyond this the voice sounds rushed; let it run over instead


def extract_audio(src, dst, rate, extra=()):
    """Write mono audio at `rate` Hz from any audio or video file (format from `dst`'s extension)."""
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-vn", "-ac", "1", "-ar", str(rate), *extra, str(dst)],
        check=True,
    )


def duration(path):
    """Length of a media file in seconds."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(out.stdout)


def from_wav_bytes(data, rate=RATE):
    """Decode WAV bytes (as returned by Gnani TTS) to a mono float32 array at `rate`."""
    with wave.open(io.BytesIO(data)) as w:
        if w.getframerate() == rate and w.getnchannels() == 1 and w.getsampwidth() == 2:
            return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    return _ffmpeg_pcm(data, ["-f", "wav"], rate)


def save_wav(path, samples, rate=RATE):
    pcm = (np.clip(samples, -1, 1) * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


def speed_up(samples, factor, rate=RATE):
    """Time-stretch without changing pitch (ffmpeg atempo)."""
    pcm = (np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes()
    return _ffmpeg_pcm(pcm, ["-f", "s16le", "-ar", str(rate), "-ac", "1"], rate, ["-af", f"atempo={factor:.4f}"])


def _ffmpeg_pcm(data, input_args, rate, filters=()):
    raw = subprocess.run(
        ["ffmpeg", "-loglevel", "error", *input_args, "-i", "-", *filters, "-ac", "1", "-ar", str(rate), "-f", "s16le", "-"],
        input=data,
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768


def fit(clip, slot_s):
    """Trim silence and speed the clip up (up to MAX_SPEEDUP) if it overruns its slot."""
    clip = _trim_silence(clip)
    clip_s = len(clip) / RATE
    if slot_s > 0 and clip_s > slot_s * 1.02:
        clip = speed_up(clip, min(clip_s / slot_s, MAX_SPEEDUP))
    return clip


def _trim_silence(clip, threshold=0.01):
    loud = np.flatnonzero(np.abs(clip) > threshold)
    if not len(loud):
        return clip
    pad = int(0.05 * RATE)
    return clip[max(loud[0] - pad, 0) : loud[-1] + pad]
