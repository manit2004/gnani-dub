// Getting ready before Start.
//
// Read the captions and make the first clip while the viewer is still choosing, so Start
// plays almost at once. Errors are kept and shown when Start is pressed.
function prepare({ forDub = false } = {}) {
  if ((session && !forDub) || !ui || extensionGone()) return;
  const target = ui.target.value;
  const videoKey = new URL(location.href).searchParams.get("v") || location.pathname;
  if (prepared && prepared.videoKey === videoKey && prepared.target === target) return;

  const p = { videoKey, target };
  p.captions = loadCaptions(target, () => prepared !== p);
  p.captions
    .then(async (captions) => {
      if (!captions) return; // it will be dubbed by listening; nothing to make ahead
      const s = { ...captions, target, video: ui.player.querySelector("video"), voiceId: null };
      const i = Math.max(lineAt(s.lines, s.video.currentTime), 0);
      await translateBatch(s, i, FIRST_BATCH);
      if (prepared === p && !session) await speak(s, s.lines[i], slotFor(s.lines, i));
    })
    .catch(() => {}); // a failure here is retried by the dub itself
  prepared = p;
}

// The video's captions, ready to translate, or null if it has none we can use (it's dubbed by
// listening instead).
async function loadCaptions(target, cancelled) {
  const { videoId, tracks } = await ask("tracks");
  let track = pickTrack(tracks, target, SOURCES);
  const language = ui.target.selectedOptions[0]?.text || target;
  if (!track) return null;
  const source = ytLangToCode(track.languageCode);
  if (source === target) throw Object.assign(new Error(`This video is already in ${language}.`), { final: true });
  // During an ad the player won't load the video's captions.
  while (isAd() && !cancelled()) {
    if (session) setStatus("Waiting for the ad to finish…");
    await sleep(500);
  }
  const doc = await ask("captions", { track }, 40000).catch((err) => {
    throw Object.assign(err, { unreadable: true });
  });
  // A transcript can come back in another of the video's languages; it says which.
  if (doc.languageCode && ytLangToCode(doc.languageCode) !== source) {
    const actual = ytLangToCode(doc.languageCode);
    if (actual === target) throw Object.assign(new Error(`This video is already in ${language}.`), { final: true });
    if (!SOURCES.includes(actual)) throw Object.assign(new Error(`its transcript is in a language we can't translate from (${doc.languageCode})`), { unreadable: true });
    track = { ...track, languageCode: doc.languageCode, kind: doc.kind || "" };
  }
  const lines = linesFromJson3(doc).map((l) => ({ ...l, translated: null, buffer: null, played: false }));
  if (!lines.length) throw new Error("The captions are empty.");
  return { videoId, source: ytLangToCode(track.languageCode), lines, trackName: track.name + (track.kind === "asr" ? " (automatic)" : "") };
}
