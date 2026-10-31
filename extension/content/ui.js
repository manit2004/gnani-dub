// The DUB button, its panel, and the subtitle and badge shown over the video.

function el(tag, props = {}, ...children) {
  // Built with DOM calls, not innerHTML: YouTube enforces Trusted Types.
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
}

function ensureUi() {
  const player = document.getElementById("movie_player");
  if (!player) return;
  // Our button goes in the player's control bar; if YouTube's layout has no such bar, it
  // floats over the video instead.
  const controls = player.querySelector(".ytp-right-controls");
  const home = controls || player;
  if (ui && player.contains(ui.panel) && home.contains(ui.button)) return;

  const button = el("button", {
    className: controls ? "ytp-button gnani-dub-button" : "gnani-dub-button gnani-dub-floating",
    title: "Gnani live dub",
    textContent: "DUB",
  });
  const target = el("select", { className: "gnani-dub-select" });
  const clone = el("input", { type: "checkbox" });
  const background = el("input", { type: "checkbox" });
  const start = el("button", { className: "gnani-dub-start", textContent: "Start dubbing" });
  const status = el("p", { className: "gnani-dub-status", textContent: "Dubs this video from its captions, or by listening if it has none." });
  const panel = el(
    "div",
    { className: "gnani-dub-panel", hidden: true },
    el("div", { className: "gnani-dub-title", textContent: "Gnani live dub" }),
    el("label", { className: "gnani-dub-row" }, el("span", { textContent: "Dub into" }), target),
    el("label", { className: "gnani-dub-check" }, background, el("span", { textContent: "Keep background sound (turned down)" })),
    el(
      "label",
      { className: "gnani-dub-check" },
      clone,
      el("span", {}, "Clone the speaker's voice", el("small", { textContent: "Only for videos you made or have permission to use." })),
    ),
    start,
    status,
  );
  const subtitle = el("div", { className: "gnani-dub-subtitle", hidden: true });
  const badge = el("div", { className: "gnani-dub-badge", hidden: true }); // why the video is waiting

  for (const node of player.querySelectorAll(".gnani-dub-panel, .gnani-dub-subtitle, .gnani-dub-badge, .gnani-dub-button")) node.remove();
  player.append(panel, subtitle, badge);
  home.prepend(button);

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
    if (!panel.hidden && extensionGone() && !session) setStatus(RELOADED, true);
    if (!panel.hidden) prepare();
  });
  button.addEventListener("mouseenter", () => prepare()); // a head start before the click
  panel.addEventListener("click", (e) => e.stopPropagation()); // don't let clicks pause the video
  panel.addEventListener("keydown", (e) => e.stopPropagation()); // or trigger YouTube shortcuts
  start.addEventListener("click", () => (session ? stop("Stopped.") : startDub()));
  for (const input of [target, clone, background]) input.addEventListener("change", saveSettings);
  target.addEventListener("change", prepare);

  ui = { player, button, panel, target, clone, background, start, status, subtitle, badge };
  loadSettings();
}

async function loadSettings() {
  const saved = extensionGone() ? {} : await chrome.storage.local.get(["target", "clone", "keepBackground"]);
  ui.target.replaceChildren(...LANGUAGES.map(([code, name]) => el("option", { value: code, textContent: name })));
  ui.target.value = saved.target || "hi-IN";
  ui.clone.checked = !!saved.clone;
  ui.background.checked = !!saved.keepBackground;
}

function saveSettings() {
  if (!extensionGone()) chrome.storage.local.set({ target: ui.target.value, clone: ui.clone.checked, keepBackground: ui.background.checked });
  if (session) {
    session.keepBackground = ui.background.checked;
    updateDuck();
  }
}

function setStatus(text, isError = false) {
  if (!ui) return;
  ui.status.textContent = text;
  ui.status.classList.toggle("gnani-dub-error", isError);
}

function showSubtitle(line) {
  if (!ui) return;
  const text = line?.translated || "";
  ui.subtitle.hidden = !text;
  if (ui.subtitle.textContent !== text) ui.subtitle.textContent = text;
}
