// Dubbing by listening (videos without captions).

// Lines are timed in seconds of audio streamed so far (s.heard), which stands still while the
// video is paused. That's what the server reports transcripts in, too.
function startListening(s, reason) {
  Object.assign(s, { mode: "listen", reason, ready: false, lines: [], heard: 0, seekAt: 0, history: [] });
  holdVideo(s, "Connecting to Gnani speech recognition…");
  if (extensionGone()) return stop(RELOADED, true);
  const port = (s.port = chrome.runtime.connect({ name: "listen" }));
  port.onMessage.addListener((msg) => {
    if (s.stopped) return;
    if (msg.type === "ready") s.ready = true;
    else if (msg.type === "transcript") heard(s, msg);
    else if (msg.type === "error") s.error = msg.message;
    else if (msg.type === "warning") console.warn("[gnani-dub]", msg.message);
  });
  port.onDisconnect.addListener(() => !s.stopped && stop(s.error || "Lost the connection to the gnani-dub server.", true));
  // Chrome stops an idle background worker after 30 s, which would drop the connection while
  // the video is paused: keep it busy.
  s.keepAlive = setInterval(() => port.postMessage({ type: "ping" }), 20000);
  setTimeout(() => {
    if (!s.ready && !s.stopped) stop(s.error || "Gnani speech recognition didn't start. Try restarting the gnani-dub server.", true);
  }, 15000);

  // Tap the original audio before it's turned down, and stream it at 16 kHz.
  const { ctx, source } = s.graph;
  const tap = (s.tap = ctx.createScriptProcessor(4096, 2, 1));
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(tap);
  tap.connect(mute).connect(ctx.destination); // a processor only runs when connected
  const resample = downsampler(ctx.sampleRate, LISTEN_RATE);
  tap.onaudioprocess = (e) => {
    if (s.stopped || s.video.paused || isAd()) return;
    const mono = toMono(e.inputBuffer);
    s.history.push({ at: s.heard, mono });
    while (s.heard - s.history[0].at > HISTORY_S) s.history.shift();
    const pcm = resample(mono);
    s.heard += pcm.length / LISTEN_RATE;
    port.postMessage({ audio: toBase64(int16Bytes(pcm)) });
  };

  on(s.video, "seeking", () => {
    // Drop what was said before the seek, and end the sentence being heard.
    stopClips(s);
    s.lines.forEach((l) => (l.played = true));
    s.seekAt = s.heard;
    port.postMessage({ type: "commit" });
    updateDuck();
  });
  on(s.video, "ended", () => port.postMessage({ type: "commit" })); // don't wait for silence that won't come
  if (ui.clone.checked) s.reference = { chunks: [], samples: 0 };
  updateDuck();
  s.timer = setInterval(() => tickListening(s), 100);
  loop(s, nextHeardTranslation);
  loop(s, nextHeardSpeech);
  setStatus(dubbingStatus(s));
}

function heard(s, msg) {
  if (msg.start_s < s.seekAt) return; // said before a seek
  const line = { text: msg.text, lang: msg.lang, start: msg.start_s, end: msg.end_s, translated: null, buffer: null, played: false, failures: 0 };
  if (line.lang === s.target) line.translated = line.text;
  else if (!SOURCES.includes(line.lang)) line.played = true; // a language we can't translate from
  if (s.lines.length > 100) s.lines = s.lines.filter((l) => !l.played);
  s.lines.push(line);
  if (line.played) return;
  holdVideo(s, "Dubbing what was just said…");
  if (s.reference && !s.reference.done) addReference(s, line);
}

// Clips play one after another as soon as they're ready; the video carries on once they've
// all been heard.
function tickListening(s) {
  if (s.stopped) return;
  if (isAd() !== s.inAd) {
    s.inAd = isAd();
    updateDuck();
  }
  if (s.inAd) return showSubtitle(null);
  const next = s.lines.find((l) => !l.played);
  if (!s.playing.length) {
    s.current = null;
    if (next?.buffer) {
      play(s, next, 0);
      s.current = next;
    }
  }
  showSubtitle(s.current);
  if (s.ready && !next) resumeVideo(s);
}

function nextHeardTranslation(s) {
  const line = s.lines.find((l) => !l.played && l.translated === null);
  return line && (() => attempt(line, () => translateHeard(s, line)));
}

function nextHeardSpeech(s) {
  const line = s.lines.find((l) => !l.played && l.translated !== null && !l.buffer);
  return line && (() => attempt(line, () => speak(s, line, line.end - line.start)));
}

async function translateHeard(s, line) {
  const { json } = await api("/api/live/translate", {
    method: "POST",
    json: { texts: [line.text], source: line.lang, target: s.target },
  });
  line.translated = json.translations[0] || line.text;
}

// A line that fails twice is skipped, so one bad sentence can't hold up the rest.
async function attempt(line, job) {
  try {
    await job();
  } catch (err) {
    if (++line.failures >= 2) line.played = true;
    throw err;
  }
}

// Box-filter downsampling that carries the leftover samples from one chunk to the next.
function downsampler(from, to) {
  const step = from / to;
  let carry = new Float32Array(0);
  let pos = 0;
  return (chunk) => {
    const input = new Float32Array(carry.length + chunk.length);
    input.set(carry);
    input.set(chunk, carry.length);
    const out = new Float32Array(Math.floor((input.length - pos) / step));
    for (let n = 0; n < out.length; n++, pos += step) {
      const a = Math.floor(pos);
      const b = Math.min(Math.floor(pos + step), input.length);
      let sum = 0;
      for (let k = a; k < b; k++) sum += input[k];
      out[n] = sum / Math.max(b - a, 1);
    }
    const used = Math.floor(pos);
    carry = input.slice(used);
    pos -= used;
    return out;
  };
}

function int16Bytes(samples) {
  const out = new Int16Array(samples.length);
  for (let k = 0; k < samples.length; k++) out[k] = Math.max(-1, Math.min(1, samples[k])) * 32767;
  return new Uint8Array(out.buffer);
}
