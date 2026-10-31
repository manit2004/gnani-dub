// Live dubbing overlay for YouTube.
//
// The video's captions are read up front, translated and spoken a little ahead of playback
// (LOOKAHEAD_S), and each clip starts when the video reaches its line. If a clip isn't ready
// yet, or the previous one is still talking, the video waits for the dub instead of the dub
// falling behind. The original audio is routed through Web Audio so it can be turned down.
//
// Videos without usable captions are dubbed by listening instead: the audio is streamed to
// Gnani speech-to-text through the server, and after each sentence the video waits while it's
// translated and spoken, like an interpreter taking turns with the speaker.
//
// The content scripts share one scope and load in the order manifest.json lists them. This one
// holds the settings and state they share, and talks to the page scripts (page/) and the server.

const LOOKAHEAD_S = 25;
const DUCK_LEVEL = 0.12; // original volume under the dub when keeping the background
const LATE_S = 0.6; // a line this far gone when we reach it is skipped instead of waited for
const REF_TARGET_S = 15; // speech to collect before cloning the speaker's voice
const FIRST_BATCH = 3; // lines needed right away are translated in a small, quick request
const TRANSLATE_BATCH = 40;
const TRANSLATE_AHEAD_S = 120;
const LISTEN_RATE = 16000; // what Gnani streaming speech-to-text takes
const HISTORY_S = 40; // audio kept for cutting voice-cloning samples when listening
const SOURCES = ["en-IN", "bn-IN", "hi-IN", "ta-IN", "te-IN", "kn-IN", "ml-IN", "mr-IN", "gu-IN", "pa-IN", "od-IN"];
const LANGUAGES = [
  ["hi-IN", "Hindi"], ["bn-IN", "Bengali"], ["ta-IN", "Tamil"], ["te-IN", "Telugu"], ["kn-IN", "Kannada"],
  ["ml-IN", "Malayalam"], ["mr-IN", "Marathi"], ["gu-IN", "Gujarati"], ["pa-IN", "Punjabi"],
];

let session = null; // the dub in progress, if any
let prepared = null; // captions, first translations and first clip, made when the panel opens
const graphs = new WeakMap(); // <video> -> its Web Audio graph (an element can only be routed once)
let ui = null;

let askId = 0;
function ask(type, extra = {}, timeoutMs = 15000) {
  const id = ++askId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error("YouTube's page didn't answer")), timeoutMs);
    function done(err, result) {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      err ? reject(err) : resolve(result);
    }
    function onMessage(e) {
      const msg = e.data;
      if (e.source !== window || msg?.tag !== "gnani-dub" || msg.dir !== "answer" || msg.id !== id) return;
      msg.error ? done(new Error(msg.error)) : done(null, msg.result);
    }
    window.addEventListener("message", onMessage);
    window.postMessage({ tag: "gnani-dub", dir: "ask", id, type, ...extra }, "*");
  });
}

// Reloading or updating the extension cuts off scripts already running in open tabs: they
// stay on the page, but can no longer reach the extension until the page is refreshed.
const RELOADED = "The extension was reloaded or updated. Refresh this page (F5) to use it.";
const extensionGone = () => !chrome.runtime?.id;

async function api(path, options = {}) {
  if (extensionGone()) throw new Error(RELOADED);
  const r = await chrome.runtime.sendMessage({ type: "api", path, ...options });
  if (!r?.ok) throw new Error(r?.error || "No answer from the extension");
  return r;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toBase64(bytes) {
  let str = "";
  for (let i = 0; i < bytes.length; i += 0x8000) str += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(str);
}
