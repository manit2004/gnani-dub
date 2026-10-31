// Runs first of the page scripts: watches the captions and transcripts YouTube's own page
// downloads, and holds what the page scripts share (on window.gnaniDub, since they run in
// YouTube's own scope and shouldn't add globals of their own).

(() => {
  const dub = (window.gnaniDub = {});
  const TIMEDTEXT = "/api/timedtext";
  const TRANSCRIPT = "/youtubei/v1/get_transcript";
  const playerDocs = []; // captions the player downloaded: { url, doc }
  const transcripts = []; // transcripts YouTube's own page fetched: { videoId, doc }
  const ours = new Set(); // our own requests, so they aren't mistaken for YouTube's
  const state = {
    playerUrl: null, // latest caption URL the player requested, with its token
    problem: "", // why the last attempt gave nothing, for the error message
  };

  function seenCaptions(url, body) {
    if (url.includes("pot=")) state.playerUrl = url;
    if (body === undefined) return;
    try {
      const doc = typeof body === "string" ? JSON.parse(body) : body;
      if (doc?.events?.length) playerDocs.push({ url, doc }) > 8 && playerDocs.shift();
    } catch {} // not json3; the URL is still useful
  }

  function seenTranscript(requestBody, body) {
    try {
      const asked = dub.describeParams(JSON.parse(requestBody).params);
      const doc = dub.transcriptDoc(typeof body === "string" ? JSON.parse(body) : body, asked);
      if (asked.videoId && doc) transcripts.push({ videoId: asked.videoId, doc }) > 8 && transcripts.shift();
    } catch {}
  }

  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (e.name.includes(TIMEDTEXT)) seenCaptions(e.name);
  }).observe({ type: "resource", buffered: true });

  // Read YouTube's caption and transcript responses as they arrive. This script runs before
  // YouTube's, so the page gets these wrapped versions; they pass everything through unchanged.
  const watched = (url) => url.includes(TIMEDTEXT) || url.includes(TRANSCRIPT);
  const responseText = (xhr) => {
    const type = xhr.responseType;
    if (type === "" || type === "text") return xhr.responseText;
    if (type === "json") return xhr.response;
    if (type === "arraybuffer") return new TextDecoder().decode(xhr.response);
  };
  const { open, send } = XMLHttpRequest.prototype;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.gnaniDubUrl = watched(String(url)) ? new URL(url, location.href).href : null;
    return open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const href = this.gnaniDubUrl;
    if (href) {
      this.addEventListener("load", () => {
        try {
          if (this.status >= 400) return;
          if (href.includes(TIMEDTEXT)) seenCaptions(href, responseText(this));
          else seenTranscript(body, responseText(this));
        } catch {}
      });
    }
    return send.call(this, body);
  };
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    let watch = null;
    try {
      const request = input instanceof Request ? input : null;
      const href = new URL(request ? request.url : String(input), location.href).href;
      // Copy the request body before fetch uses it up.
      if (watched(href) && !ours.has(href)) {
        watch = { href, requestBody: typeof init?.body === "string" ? Promise.resolve(init.body) : request?.clone().text() };
      }
    } catch {}
    const result = nativeFetch.call(this, input, init);
    if (watch) {
      const { href, requestBody } = watch;
      result
        .then(async (r) => {
          if (!r.ok) return;
          const body = await r.clone().text();
          if (href.includes(TIMEDTEXT)) seenCaptions(href, body);
          else seenTranscript(await requestBody, body);
        })
        .catch(() => {});
    }
    return result;
  };

  async function waitFor(check, ms) {
    for (let waited = 0; waited < ms && !check(); waited += 250) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  Object.assign(dub, { TIMEDTEXT, TRANSCRIPT, state, playerDocs, transcripts, ours, waitFor });
})();
