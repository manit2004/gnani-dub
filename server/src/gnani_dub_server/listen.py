"""Relay the extension's audio to Gnani streaming speech-to-text, for videos without captions.

The extension sends 16 kHz mono 16-bit PCM in whatever chunks its audio callback produces.
Gnani wants exactly 1,024-byte frames at real-time cadence, so audio is buffered here and
paced out. Each transcript goes back with where its speech sits in the stream (in seconds of
audio sent), which the extension uses to cut voice-cloning samples and to drop speech from
before a seek.

A Gnani session lasts at most 15 minutes, so it's replaced between sentences after 14, and
reconnected if it drops; audio waits in the buffer meanwhile.
"""

import asyncio
import json
import time

import websockets
from fastapi import WebSocket, WebSocketDisconnect

from . import gnani

STT_STREAM = "wss://api.vachana.ai/stt/v3/stream"
RATE = 16000
FRAME = 1024  # bytes: 512 samples, 32 ms
FRAME_S = 512 / RATE
CATCH_UP_BYTES = RATE * 2  # more than 1 s waiting: send without pacing until it's down again
ROTATE_S = 14 * 60
HEADERS = {
    "model": "prisma-v3.0",
    "language_code": "indic-auto",  # this account rejects a list of languages
    "format": "verbatim",  # numbers as words, as they should be spoken
    "x-sample-rate": str(RATE),
    "x-idle-timeout-sec": "900",  # the viewer may pause for a while
    # Close a segment at each sentence pause: dub lines start sooner, and with the default
    # 500 ms Prisma v3.0 dropped the last sentence of a multi-sentence segment in our tests.
    "x-min-silence-ms": "300",
    "x-max-speech-s": "12",  # don't let a long monologue hold the dub back
}


class GnaniError(Exception):
    pass


async def listen(client: WebSocket):
    origin = client.headers.get("origin") or ""
    # Browsers always send Origin on a WebSocket, and any web page may open one, so this check
    # is what keeps other sites off your credits.
    if not origin.startswith("chrome-extension://"):
        await client.close(code=1008, reason="Only the gnani-dub extension can use this route")
        return
    await client.accept()
    await Relay(client).run()


class Relay:
    def __init__(self, client):
        self.client = client
        self.buffer = bytearray()
        self.has_audio = asyncio.Event()
        self.received_bytes = 0
        self.sent_bytes = 0
        self.commit_at = None  # stream position after which to close the open utterance
        self.starts = {}  # utterance id -> stream position (bytes) when speech started
        self.done = False

    async def run(self):
        reader = asyncio.create_task(self.from_client())
        try:
            failures = 0
            while not self.done:
                try:
                    await self.session()
                    failures = 0
                except (GnaniError, OSError, websockets.WebSocketException) as e:
                    failures += 1
                    if failures >= 3 or isinstance(e, GnaniError):
                        await self.send({"type": "error", "message": f"Gnani speech recognition: {e}"})
                        break
                    await asyncio.sleep(failures)
        except WebSocketDisconnect:
            pass
        finally:
            reader.cancel()
            try:
                await self.client.close()
            except (RuntimeError, WebSocketDisconnect):
                pass  # already closed

    async def session(self):
        headers = {"x-api-key-id": gnani.load_key(), **HEADERS}
        async with websockets.connect(STT_STREAM, additional_headers=headers) as g:
            hello = json.loads(await g.recv())
            if hello.get("type") != "connected":
                raise GnaniError(hello.get("message") or hello)
            await self.send({"type": "ready"})
            self.starts.clear()
            opened = time.monotonic()
            tasks = [asyncio.create_task(self.pump(g)), asyncio.create_task(self.from_gnani(g, opened))]
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
            for t in done:
                t.result()  # re-raise a failure

    async def from_client(self):
        try:
            while True:
                msg = await self.client.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                if msg.get("bytes"):
                    self.buffer += msg["bytes"]
                    self.received_bytes += len(msg["bytes"])
                elif msg.get("text") and json.loads(msg["text"]).get("type") == "commit":
                    self.commit_at = self.received_bytes  # e.g. the viewer seeked: end the sentence here
                self.has_audio.set()
        finally:
            self.done = True
            self.has_audio.set()

    async def pump(self, g):
        """Send buffered audio to Gnani one frame every 32 ms."""
        loop = asyncio.get_running_loop()
        due = loop.time()
        while not self.done:
            if self.commit_at is not None and self.sent_bytes + FRAME > self.commit_at:
                self.commit_at = None
                await g.send(json.dumps({"type": "commit"}))
            if len(self.buffer) < FRAME:
                self.has_audio.clear()
                await self.has_audio.wait()
                due = max(due, loop.time())
                continue
            frame = bytes(self.buffer[:FRAME])
            del self.buffer[:FRAME]
            await g.send(frame)
            self.sent_bytes += FRAME
            due += FRAME_S
            if len(self.buffer) < CATCH_UP_BYTES:
                await asyncio.sleep(max(0, due - loop.time()))

    async def from_gnani(self, g, opened):
        async for raw in g:
            msg = json.loads(raw)
            kind = msg.get("type")
            if kind == "speech_start":
                self.starts[msg.get("utterance_id")] = self.sent_bytes
            elif kind == "transcript":
                await self.transcript(msg)
                if time.monotonic() - opened > ROTATE_S and not self.starts:
                    return  # between sentences: start a fresh session before the 15-minute cap
            elif kind == "error":
                await self.send({"type": "warning", "message": msg.get("message", "")})

    async def transcript(self, msg):
        duration = msg.get("audio_duration_ms", 0) / 1000
        start_bytes = self.starts.pop(msg.get("utterance_id"), None)
        # speech_start comes once VAD has heard ~0.1 s of speech
        start = start_bytes / 2 / RATE - 0.1 if start_bytes is not None else self.sent_bytes / 2 / RATE - duration - 0.5
        text = (msg.get("text") or "").strip()
        if text:
            await self.send({
                "type": "transcript",
                "text": text,
                "lang": msg.get("detected_language_code"),
                "start_s": round(max(start, 0), 2),
                "end_s": round(max(start, 0) + duration, 2),
            })

    async def send(self, msg):
        try:
            await self.client.send_text(json.dumps(msg, ensure_ascii=False))
        except (WebSocketDisconnect, RuntimeError):
            self.done = True
