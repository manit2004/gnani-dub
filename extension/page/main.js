// Runs in YouTube's own page (the "MAIN" world) so it can reach the player, after the other
// page scripts (capture.js, transcript.js).
// It answers two questions from the content scripts over window.postMessage:
//   tracks   -> the caption tracks this video has
//   captions -> one track's timed captions (YouTube's json3 format)
//
// YouTube often refuses a track's caption URL unless it carries a proof-of-origin token
// ("pot") that only the player adds, a token may not work a second time, and caption
// downloads get rate-limited. So, in order, we try:
//   1. the captions the player itself downloaded, if it has
//   2. the track's own caption URL
//   3. the video's transcript, asked for directly, then by opening the "Show transcript"
//      panel so YouTube asks for it with its own credentials (a different endpoint from
//      caption downloads, so a rate limit there doesn't apply)
//   4. getting the player to load captions, and keeping its download, or else reusing its
//      caption URL, token included, with our track's language swapped in

(() => {
  const TAG = "gnani-dub";
  const { state, playerDocs, ours, waitFor, transcriptFor, transcript, transcriptPanel } = window.gnaniDub;

  function player() {
    return document.getElementById("movie_player");
  }

  function tracks() {
    const response = player()?.getPlayerResponse?.();
    const list = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    return {
      videoId: response?.videoDetails?.videoId || null,
      tracks: list.map((t) => ({
        languageCode: t.languageCode,
        kind: t.kind || "",
        name: t.name?.simpleText || t.name?.runs?.map((r) => r.text).join("") || t.languageCode,
        baseUrl: t.baseUrl,
      })),
    };
  }

  async function fetchJson3(url) {
    const u = new URL(url, location.href);
    u.searchParams.set("fmt", "json3");
    ours.add(u.href);
    try {
      const r = await fetch(u, { credentials: "include" });
      const text = r.ok ? await r.text() : "";
      state.problem = !r.ok ? `HTTP ${r.status}` : !text ? "an empty reply" : "";
      const doc = text ? JSON.parse(text) : null;
      if (text && !doc?.events?.length) state.problem = "no captions in the reply";
      return doc?.events?.length ? doc : null;
    } catch (err) {
      state.problem = err instanceof SyntaxError ? "a reply that isn't json3" : "a failed request";
      return null;
    } finally {
      ours.delete(u.href);
    }
  }

  function playerUrlFor(videoId) {
    return state.playerUrl && new URL(state.playerUrl).searchParams.get("v") === videoId ? state.playerUrl : null;
  }

  // Captions the player downloaded for this track: same language, the same kind if possible,
  // and not YouTube's auto-translation.
  function playerDocFor(videoId, track) {
    const matches = playerDocs.filter(({ url }) => {
      const q = new URL(url).searchParams;
      return q.get("v") === videoId && q.get("lang") === track.languageCode && !q.get("tlang");
    });
    const sameKind = matches.filter(({ url }) => (new URL(url).searchParams.get("kind") || "") === track.kind);
    return (sameKind.at(-1) || matches.at(-1))?.doc || null;
  }

  async function captions(track) {
    const p = player();
    const videoId = p.getPlayerResponse?.()?.videoDetails?.videoId;
    const doc = playerDocFor(videoId, track) || (await fetchJson3(track.baseUrl));
    if (doc) return doc;
    const tried = [`captions: ${state.problem}`];

    const fromTranscript = transcriptFor(videoId, track) || (await transcript(videoId, track)) || (await transcriptPanel(videoId, track));
    if (fromTranscript) return fromTranscript;
    tried.push(`transcript: ${state.problem}`);

    // Get the player to request captions once, so we can keep them, or at least learn a token
    // for this video.
    const ready = () => playerDocFor(videoId, track) || playerUrlFor(videoId);
    let template = playerUrlFor(videoId);
    if (!template) {
      // Ask through the player API first, then press the CC button as a viewer would, and put
      // things back as they were afterwards.
      const wasOn = !!p.getOption?.("captions", "track")?.languageCode;
      p.loadModule?.("captions");
      p.setOption?.("captions", "track", { languageCode: track.languageCode });
      await waitFor(ready, 4000);
      const cc = document.querySelector("#movie_player .ytp-subtitles-button");
      let pressed = false;
      if (!ready() && cc?.getAttribute("aria-pressed") === "false") {
        cc.click();
        pressed = true;
        await waitFor(ready, 6000);
      }
      // The URL can show up a moment before its response has been read.
      if (!playerDocFor(videoId, track)) await waitFor(() => playerDocFor(videoId, track), 1500);
      if (pressed) cc.click();
      else if (!wasOn) p.unloadModule?.("captions");
      template = playerUrlFor(videoId);
    }
    const fromPlayer = playerDocFor(videoId, track);
    if (fromPlayer) return fromPlayer;
    if (!template) throw new Error(`${tried.join("; ")}; the player didn't load them either`);

    const u = new URL(template);
    u.searchParams.set("lang", track.languageCode);
    if (track.kind) u.searchParams.set("kind", track.kind);
    else u.searchParams.delete("kind");
    u.searchParams.delete("tlang"); // no YouTube auto-translation; Sarvam translates
    const result = (await fetchJson3(u.href)) || (await fetchJson3(template));
    if (!result) throw new Error(`${tried.join("; ")}; the player's caption link: ${state.problem}`);
    return result;
  }

  window.addEventListener("message", async (e) => {
    const msg = e.data;
    if (e.source !== window || msg?.tag !== TAG || msg.dir !== "ask") return;
    const reply = (body) => window.postMessage({ tag: TAG, dir: "answer", id: msg.id, ...body }, "*");
    try {
      if (msg.type === "tracks") reply({ result: tracks() });
      else if (msg.type === "captions") reply({ result: await captions(msg.track) });
    } catch (err) {
      reply({ error: err.message || String(err) });
    }
  });
})();
