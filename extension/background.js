// Calls the local gnani-dub server for the content scripts (content/).
//
// Requests go from here rather than from the YouTube page because extension requests to the
// server's host permission aren't subject to CORS or Chrome's local-network prompt. Audio goes
// both ways base64-encoded, since extension messages carry JSON only.

const DEFAULT_SERVER = "http://127.0.0.1:8000";

async function server() {
  const { server } = await chrome.storage.local.get("server");
  return (server || DEFAULT_SERVER).replace(/\/$/, "");
}

async function call({ path, method = "GET", json, wavB64, want = "json" }) {
  const headers = { "X-Gnani-Dub": "1" };
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (wavB64) {
    headers["Content-Type"] = "audio/wav";
    body = fromBase64(wavB64);
  }

  let r;
  try {
    r = await fetch(`${await server()}${path}`, { method, headers, body });
  } catch {
    throw new Error(`Can't reach the gnani-dub server at ${await server()}. Start it with: cd server && uv run gnani-dub-server`);
  }
  if (!r.ok) {
    let detail = `${r.status}`;
    try {
      detail = (await r.json()).detail || detail;
    } catch {}
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  if (want === "audio") return { audioB64: toBase64(new Uint8Array(await r.arrayBuffer())) };
  return { json: await r.json() };
}

const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "api") return;
  call(msg).then(
    (result) => sendResponse({ ok: true, ...result }),
    (err) => sendResponse({ ok: false, error: err.message || String(err) }),
  );
  return true; // respond asynchronously
});

// For videos without captions: content/listen.js streams the video's audio over a "listen" port, and
// it goes on to the server's WebSocket, which relays it to Gnani speech-to-text. Transcripts
// come back the same way.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "listen") return;
  const waiting = []; // audio sent before the WebSocket is open
  let ws = null;
  let closed = false;

  // Listen right away: audio can arrive before the server address has been read.
  port.onMessage.addListener((msg) => {
    const data = msg.audio ? fromBase64(msg.audio) : JSON.stringify(msg);
    if (ws?.readyState === WebSocket.OPEN) ws.send(data);
    else if (!ws || ws.readyState === WebSocket.CONNECTING) waiting.push(data);
  });
  port.onDisconnect.addListener(() => {
    closed = true;
    ws?.close();
  });

  server().then((base) => {
    if (closed) return;
    let opened = false;
    ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/live/listen`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      opened = true;
      waiting.splice(0).forEach((m) => ws.send(m));
    };
    ws.onmessage = (e) => !closed && port.postMessage(JSON.parse(e.data));
    ws.onclose = () => {
      if (closed) return;
      closed = true;
      if (!opened) port.postMessage({ type: "error", message: `Can't reach the gnani-dub server at ${base}. Start it with: cd server && uv run gnani-dub-server` });
      port.disconnect();
    };
  });
});

// Clicking the toolbar icon opens the panel on a YouTube tab. A tab that was already open when
// the extension was installed has no content script yet, so reload it.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url?.startsWith("https://www.youtube.com/")) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "toggle-panel" });
  } catch {
    chrome.tabs.reload(tab.id);
  }
});
