// Getting a video's transcript, the same text the "Show transcript" panel shows.

(() => {
  const dub = window.gnaniDub;
  const { TRANSCRIPT, state, transcripts, ours, waitFor } = dub;

  // A transcript YouTube fetched for this video, preferably in the track's language. It may
  // be in another of the video's languages; the doc says which.
  function transcriptFor(videoId, track) {
    const matches = transcripts.filter((t) => t.videoId === videoId);
    return (matches.filter((t) => t.doc.languageCode === track.languageCode).at(-1) || matches.at(-1))?.doc || null;
  }

  // Ask for the track's transcript ourselves.
  async function transcript(videoId, track) {
    const cfg = window.ytcfg;
    const context = cfg?.get?.("INNERTUBE_CONTEXT");
    if (!context || !videoId) {
      state.problem = "not available on this page";
      return null;
    }
    const url = new URL(`${TRANSCRIPT}?prettyPrint=false`, location.href).href;
    ours.add(url);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Youtube-Client-Name": String(cfg.get("INNERTUBE_CONTEXT_CLIENT_NAME") ?? 1),
          "X-Youtube-Client-Version": cfg.get("INNERTUBE_CLIENT_VERSION") || context.client?.clientVersion || "",
        },
        body: JSON.stringify({ context, params: transcriptParams(videoId, track) }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) {
        state.problem = `HTTP ${r.status}${body?.error?.message ? ` ${body.error.message}` : ""}`;
        return null;
      }
      const doc = transcriptDoc(body, track);
      if (!doc) state.problem = "no lines in the reply";
      return doc;
    } catch {
      state.problem = "a failed request";
      return null;
    } finally {
      ours.delete(url);
    }
  }

  // Open the "Show transcript" panel so YouTube fetches the transcript itself, keep what it
  // gets, and close the panel again.
  async function transcriptPanel(videoId, track) {
    const button = document.querySelector("ytd-video-description-transcript-section-renderer button");
    if (!button) {
      state.problem += state.problem ? "; no Show transcript button" : "no Show transcript button";
      return null;
    }
    const panel = () =>
      document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]');
    const wasOpen = panel()?.getAttribute("visibility") === "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED";
    if (!wasOpen) button.click();
    await waitFor(() => transcriptFor(videoId, track) || panelSegments(panel()).length, 8000);
    let doc = transcriptFor(videoId, track);
    if (!doc) await waitFor(() => transcriptFor(videoId, track), 1000); // the response may still be on its way
    doc = transcriptFor(videoId, track) || docFromPanel(panel(), track);
    if (!wasOpen) panel()?.querySelector("#visibility-button button")?.click();
    if (!doc) state.problem += "; the transcript panel didn't load it either";
    return doc;
  }

  function panelSegments(panelNode) {
    return [...(panelNode?.querySelectorAll("ytd-transcript-segment-renderer") || [])];
  }

  // Last resort: the lines shown in the panel, timed to the second.
  function docFromPanel(panelNode, track) {
    const lines = panelSegments(panelNode)
      .map((seg) => ({
        start: seg.querySelector(".segment-timestamp")?.textContent.trim().split(":").reduce((t, part) => t * 60 + Number(part), 0),
        text: seg.querySelector(".segment-text")?.textContent.trim() || "",
      }))
      .filter((l) => Number.isFinite(l.start) && l.text);
    if (!lines.length) return null;
    const events = lines.map((l, i) => ({
      tStartMs: l.start * 1000,
      dDurationMs: ((lines[i + 1]?.start ?? l.start + 3) - l.start) * 1000,
      segs: [{ utf8: l.text }],
    }));
    return { events, languageCode: track.languageCode };
  }

  // A get_transcript response as json3 events.
  function transcriptDoc(response, asked) {
    const events = segments(response).map(({ startMs, endMs, snippet }) => ({
      tStartMs: Number(startMs),
      dDurationMs: Number(endMs) - Number(startMs),
      segs: [{ utf8: snippet?.simpleText ?? snippet?.runs?.map((run) => run.text).join("") ?? "" }],
    }));
    return events.length ? { events, languageCode: asked.languageCode, kind: asked.kind } : null;
  }

  function segments(node, out = []) {
    if (Array.isArray(node)) node.forEach((n) => segments(n, out));
    else if (node && typeof node === "object") {
      if (node.transcriptSegmentRenderer) out.push(node.transcriptSegmentRenderer);
      else Object.values(node).forEach((n) => segments(n, out));
    }
    return out;
  }

  // get_transcript's params: a small protobuf naming the video and the track.
  function transcriptParams(videoId, track) {
    const field = (n, value) => {
      if (typeof value === "number") return String.fromCharCode(n << 3, value);
      return String.fromCharCode((n << 3) | 2, value.length) + value;
    };
    const trackParams = btoa(field(1, track.kind === "asr" ? "asr" : "") + field(2, track.languageCode) + field(3, ""));
    return btoa(
      field(1, videoId) + field(2, encodeURIComponent(trackParams)) + field(3, 1) +
        field(5, "engagement-panel-searchable-transcript-search-panel") + field(6, 0) + field(7, 1) + field(8, 1),
    );
  }

  // The video and track a get_transcript request asked for (the reverse of the above).
  function describeParams(params) {
    const fields = (bytes) => {
      const out = {};
      let i = 0;
      const varint = () => {
        let v = 0;
        for (let shift = 0, b = 128; b >= 128 && i < bytes.length; shift += 7) {
          b = bytes.charCodeAt(i++);
          v += (b & 127) * 2 ** shift;
        }
        return v;
      };
      while (i < bytes.length) {
        const key = varint();
        if ((key & 7) === 0) out[key >> 3] = varint();
        else if ((key & 7) === 2) {
          const length = varint();
          out[key >> 3] = bytes.slice(i, i + length);
          i += length;
        } else break;
      }
      return out;
    };
    try {
      const outer = fields(atob(params));
      const inner = fields(atob(decodeURIComponent(outer[2] || "")));
      return { videoId: outer[1], languageCode: inner[2], kind: inner[1] || "" };
    } catch {
      return {};
    }
  }

  Object.assign(dub, { transcriptFor, transcript, transcriptPanel, transcriptDoc, describeParams });
})();
