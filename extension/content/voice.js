// Voice cloning.

// When listening, the reference is cut from the audio of recognised sentences.
function addReference(s, line) {
  const ref = s.reference;
  const rate = s.graph.ctx.sampleRate;
  for (const { at, mono } of s.history) {
    const from = Math.max(0, Math.round((line.start - at) * rate));
    const to = Math.min(mono.length, Math.round((line.end - at) * rate));
    if (to > from) {
      ref.chunks.push(mono.subarray(from, to));
      ref.samples += to - from;
    }
  }
  if (ref.samples >= REF_TARGET_S * rate) {
    ref.done = true;
    cloneVoice(s, ref.chunks, rate);
  }
}

// Record the original audio while captions say someone is speaking, then clone from it.
function collectReference(s) {
  const { ctx, source } = s.graph;
  const processor = ctx.createScriptProcessor(4096, 2, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(processor);
  processor.connect(mute).connect(ctx.destination); // a processor only runs when connected
  const ref = (s.reference = { processor, chunks: [], samples: 0 });

  processor.onaudioprocess = (e) => {
    const t = s.video.currentTime;
    const line = s.lines[lineAt(s.lines, t)];
    if (ref.done || s.stopped || s.video.paused || isAd() || !line || t > line.end) return;
    const mono = toMono(e.inputBuffer);
    ref.chunks.push(mono);
    ref.samples += mono.length;
    if (ref.samples >= REF_TARGET_S * ctx.sampleRate) {
      ref.done = true;
      source.disconnect(processor);
      processor.disconnect();
      cloneVoice(s, ref.chunks, ctx.sampleRate);
    }
  };
}

async function cloneVoice(s, chunks, rate) {
  try {
    const { json } = await api("/api/live/voice", { method: "POST", wavB64: toBase64(wavBytes(chunks, rate)) });
    if (s.stopped) return;
    s.voiceId = json.voice_id;
    // Drop stock-voice clips so they're remade in the cloned voice when next needed,
    // except the one about to start. (When listening, new lines just use the cloned voice.)
    const soon = s.video.currentTime + 1.5;
    for (const line of s.mode === "listen" ? [] : s.lines) {
      if (line.buffer && line.voiceId !== s.voiceId && (line.played || line.start > soon)) line.buffer = null;
    }
    setStatus(`Cloned the speaker's voice from ${json.reference_s} s of speech.`);
  } catch (err) {
    if (s.stopped) return;
    s.reference.failed = true;
    setStatus(`Couldn't clone the voice, keeping the stock one: ${err.message}`, true);
  }
}

function toMono(input) {
  const mono = new Float32Array(input.length);
  for (let c = 0; c < input.numberOfChannels; c++) {
    const data = input.getChannelData(c);
    for (let k = 0; k < data.length; k++) mono[k] += data[k] / input.numberOfChannels;
  }
  return mono;
}

function wavBytes(chunks, rate) {
  const n = chunks.reduce((sum, c) => sum + c.length, 0);
  const buf = new DataView(new ArrayBuffer(44 + n * 2));
  const text = (o, str) => [...str].forEach((ch, k) => buf.setUint8(o + k, ch.charCodeAt(0)));
  text(0, "RIFF");
  buf.setUint32(4, 36 + n * 2, true);
  text(8, "WAVEfmt ");
  buf.setUint32(16, 16, true);
  buf.setUint16(20, 1, true); // PCM
  buf.setUint16(22, 1, true); // mono
  buf.setUint32(24, rate, true);
  buf.setUint32(28, rate * 2, true);
  buf.setUint16(32, 2, true);
  buf.setUint16(34, 16, true);
  text(36, "data");
  buf.setUint32(40, n * 2, true);
  let o = 44;
  for (const c of chunks) {
    for (const v of c) {
      buf.setInt16(o, Math.max(-1, Math.min(1, v)) * 32767, true);
      o += 2;
    }
  }
  return new Uint8Array(buf.buffer);
}
