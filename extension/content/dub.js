// Starting and stopping a dub, the audio graph, and keeping clips in sync with the video.

async function startDub() {
  const video = ui.player.querySelector("video");
  if (!video) return setStatus("No video found on this page.", true);
  if (extensionGone()) return setStatus(RELOADED, true);
  const target = ui.target.value;
  const s = (session = {
    video,
    target,
    keepBackground: ui.background.checked,
    lines: [],
    playing: [],
    waiting: null,
    pausedByUs: false,
    voiceId: null,
    stopped: false,
    listeners: [],
  });
  ui.start.textContent = "Stop dubbing";
  ui.player.classList.add("gnani-dubbing");

  try {
    s.graph = audioGraph(video);
    await s.graph.ctx.resume();

    // Pausing freezes the dub too, but at the end the last lines are left to finish.
    on(video, "pause", () => !s.pausedByUs && !video.ended && s.graph.ctx.suspend());
    on(video, "play", () => {
      s.pausedByUs = false;
      s.graph.ctx.resume();
    });
    holdVideo(s, "Reading captions…"); // the dub takes over from here
    let captions;
    let reason = "No captions";
    try {
      prepare({ forDub: true });
      captions = await prepared.captions;
    } catch (err) {
      if (err.final) throw err;
      try {
        if (err.unreadable) throw err; // the player already had its chance; don't make the viewer wait twice
        prepared = null; // the earlier attempt failed (an ad, a slow page): try once more
        prepare({ forDub: true });
        captions = await prepared.captions;
      } catch (err) {
        if (err.final) throw err;
        reason = `This video has captions, but YouTube wouldn't let us read them (${err.message})`;
      }
    }
    if (s.stopped) return;

    if (!captions) return startListening(s, reason);

    Object.assign(s, captions);
    // Clips made while the panel was open arrive as bytes; decode them for playback.
    for (const line of s.lines) {
      if (line.audio && !line.buffer) line.buffer = await decode(s, line.audio);
    }
    on(video, "seeking", () => resetAfterSeek(s));
    if (ui.clone.checked) collectReference(s);
    updateDuck();
    s.timer = setInterval(() => tick(s), 100);
    loop(s, nextTranslation);
    loop(s, nextSpeech);
    setStatus(dubbingStatus(s));
  } catch (err) {
    stop(err.message || String(err), true);
  }
}

function stop(message, isError = false) {
  const s = session;
  if (s) {
    s.stopped = true;
    clearInterval(s.timer);
    clearInterval(s.keepAlive);
    s.listeners.forEach(([node, type, fn]) => node.removeEventListener(type, fn));
    s.playing.forEach((n) => n.stop());
    s.reference?.processor?.disconnect();
    if (s.tap) {
      s.graph.source.disconnect(s.tap);
      s.tap.disconnect();
    }
    s.port?.disconnect();
    if (s.graph) {
      s.graph.duck.gain.setTargetAtTime(1, s.graph.ctx.currentTime, 0.05);
      s.graph.ctx.resume();
    }
    if (s.pausedByUs) s.video.play().catch(() => {});
  }
  session = null;
  if (ui) {
    ui.start.textContent = "Start dubbing";
    ui.player.classList.remove("gnani-dubbing");
    showSubtitle(null);
    ui.badge.hidden = true;
  }
  setStatus(message, isError);
}

function on(node, type, fn) {
  node.addEventListener(type, fn);
  session.listeners.push([node, type, fn]);
}

function audioGraph(video) {
  if (graphs.has(video)) return graphs.get(video);
  const ctx = new AudioContext();
  const source = ctx.createMediaElementSource(video);
  const duck = ctx.createGain();
  source.connect(duck).connect(ctx.destination);
  const dub = ctx.createGain();
  dub.connect(ctx.destination);
  const graph = { ctx, source, duck, dub };
  graphs.set(video, graph);
  return graph;
}

function updateDuck() {
  const s = session;
  if (!s?.graph) return;
  const level = isAd() ? 1 : !s.keepBackground ? 0 : s.playing.length ? DUCK_LEVEL : 1;
  s.graph.duck.gain.setTargetAtTime(level, s.graph.ctx.currentTime, 0.05);
}

function isAd() {
  return ui?.player.classList.contains("ad-showing");
}

// Index of the last line that has started by time t, or -1.
function lineAt(lines, t) {
  let lo = 0, hi = lines.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start <= t) (found = mid), (lo = mid + 1);
    else hi = mid - 1;
  }
  return found;
}

function tick(s) {
  if (s.stopped) return;
  if (isAd() !== s.inAd) {
    s.inAd = isAd();
    updateDuck(); // ads play at full volume
  }
  if (s.inAd) return showSubtitle(null);
  const { video, lines } = s;
  const t = video.currentTime;
  const line = lines[lineAt(lines, t)];
  showSubtitle(line && t < line.end + 0.4 ? line : null);
  if (video.paused && !s.pausedByUs) return; // the viewer paused
  if (!line || line.played) return resumeVideo(s);

  const late = t - line.start;
  if (s.playing.length) {
    // The previous clip is still talking: hold the video so the two don't overlap.
    return holdVideo(s, "Letting the dub finish…");
  }
  if (line.buffer) {
    if (late < line.buffer.duration - 0.3) play(s, line, late < LATE_S ? 0 : late);
    else line.played = true;
    s.waiting = null;
    return resumeVideo(s);
  }
  if (late > LATE_S) {
    line.played = true; // we arrived mid-line (a seek, or just started): skip it rather than stall
    return;
  }
  s.waiting = line;
  holdVideo(s, "Waiting for the dub to catch up…");
}

// Pause the video for the dub, and say why on the video itself.
function holdVideo(s, message) {
  if (s.video.paused && !s.pausedByUs) return; // the viewer paused it
  if (ui.badge.textContent !== message) {
    ui.badge.textContent = message;
    setStatus(message);
  }
  ui.badge.hidden = false;
  if (s.pausedByUs) return;
  s.pausedByUs = true;
  s.video.pause();
}

function resumeVideo(s) {
  if (!s.pausedByUs || s.playing.length) return;
  s.pausedByUs = false;
  ui.badge.hidden = true;
  ui.badge.textContent = "";
  s.video.play().catch(() => {});
  setStatus(dubbingStatus(s));
}

function dubbingStatus(s) {
  const voice = s.voiceId ? "the speaker's cloned voice" : s.reference && !s.reference.failed ? "a stock voice until the speaker's voice is cloned" : "a stock voice";
  const language = ui.target.selectedOptions[0].text;
  if (s.mode === "listen") return `${s.reason}, so listening instead: dubbing into ${language} after each sentence, in ${voice}.`;
  return `Dubbing ${s.trackName} captions into ${language}, in ${voice}.`;
}

function play(s, line, offset) {
  const node = s.graph.ctx.createBufferSource();
  node.buffer = line.buffer;
  node.playbackRate.value = s.video.playbackRate;
  node.connect(s.graph.dub);
  node.onended = () => {
    s.playing = s.playing.filter((n) => n !== node);
    updateDuck(); // tick() resumes the video if it was held for this clip
  };
  node.start(0, offset);
  s.playing.push(node);
  line.played = true;
  updateDuck();
}

function stopClips(s) {
  s.playing.forEach((n) => {
    n.onended = null;
    n.stop();
  });
  s.playing = [];
}

function resetAfterSeek(s) {
  stopClips(s);
  s.waiting = null;
  const t = s.video.currentTime;
  s.lines.forEach((l) => (l.played = l.end <= t));
  updateDuck();
}
