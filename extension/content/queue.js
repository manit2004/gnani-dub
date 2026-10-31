// Making translations and clips ahead of playback.

// Two loops run side by side: translation keeps ahead of speech, and speech makes clips just
// ahead of playback, one request at a time (Gnani allows one active request per account).
async function loop(s, nextJob) {
  while (!s.stopped) {
    try {
      const job = nextJob(s);
      if (job) await job();
      else await sleep(150);
    } catch (err) {
      if (s.stopped) return;
      setStatus(err.message || String(err), true);
      await sleep(3000);
    }
  }
}

function nextTranslation(s) {
  const t = s.video.currentTime;
  const { lines } = s;
  for (let i = Math.max(lineAt(lines, t), 0); i < lines.length && lines[i].start < t + TRANSLATE_AHEAD_S; i++) {
    if (lines[i].translated === null) {
      // Lines about to play go in a small batch so they come back fast.
      return () => translateBatch(s, i, lines[i].start < t + 10 ? FIRST_BATCH : TRANSLATE_BATCH);
    }
  }
  return null;
}

function nextSpeech(s) {
  if (isAd()) return null;
  const t = s.video.currentTime;
  const { lines } = s;
  for (let i = Math.max(lineAt(lines, t), 0); i < lines.length && lines[i].start < t + LOOKAHEAD_S; i++) {
    const line = lines[i];
    if (!line.played && line.translated !== null && !line.buffer) return () => speak(s, line, slotFor(lines, i));
  }
  return null;
}

async function translateBatch(s, i, size) {
  const batch = s.lines.slice(i).filter((l) => l.translated === null).slice(0, size);
  const { json } = await api("/api/live/translate", {
    method: "POST",
    json: { texts: batch.map((l) => l.text), source: s.source, target: s.target },
  });
  batch.forEach((l, k) => (l.translated = json.translations[k] || l.text));
}

// Fetch a line's clip, sped up if needed to last at most maxS. During a dub it's decoded for
// playback; while preparing it's kept as bytes, because the audio graph only exists once the
// viewer presses Start.
async function speak(s, line, maxS) {
  const voiceId = s.voiceId;
  const { audioB64 } = await api("/api/live/speak", {
    method: "POST",
    want: "audio",
    json: { text: line.translated, lang: s.target, voice_id: voiceId, max_s: maxS },
  });
  const bytes = Uint8Array.from(atob(audioB64), (c) => c.charCodeAt(0));
  if (s.graph) line.buffer = await decode(s, bytes);
  else line.audio = bytes;
  line.voiceId = voiceId;
}

function decode(s, bytes) {
  return s.graph.ctx.decodeAudioData(bytes.slice().buffer);
}
