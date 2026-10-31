// Start-up: keep the button in the player and answer the toolbar icon.

// YouTube is a single-page app: stop on navigation, and keep the button in the player.
document.addEventListener("yt-navigate-start", () => session && stop("Stopped: you opened another video."));
setInterval(ensureUi, 1000);
ensureUi();

// The toolbar icon opens the panel too (see background.js).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "toggle-panel") return;
  ensureUi();
  if (ui) ui.panel.hidden = !ui.panel.hidden;
  if (ui && !ui.panel.hidden) prepare();
  sendResponse({ ok: !!ui });
});
console.info("[gnani-dub] loaded");
