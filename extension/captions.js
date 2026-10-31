// Turning YouTube captions into dubbing lines. Plain functions, shared with the content scripts
// (content scripts listed together share one scope) and loadable in Node for tests.

const SENTENCE_END = /[।॥?!.]["'”’)\]]*$/;
const MAX_LINE_S = 9; // long enough for a sentence, short enough to keep the dub in sync
const GAP_S = 0.9; // a pause this long ends a line even without punctuation

// Gnani and Sarvam share codes like hi-IN; YouTube uses hi, bn, en-US... Odia is "or" on YouTube.
function ytLangToCode(languageCode) {
  const base = languageCode.split("-")[0].toLowerCase();
  return `${base === "or" ? "od" : base}-IN`;
}

// Pick the caption track to dub from: hand-written captions before automatic ones, in a language
// we can translate from. Returns null if there's nothing usable.
function pickTrack(tracks, target, sources) {
  const usable = tracks.filter((t) => sources.includes(ytLangToCode(t.languageCode)));
  const rank = (t) => (ytLangToCode(t.languageCode) === target ? 2 : 0) + (t.kind === "asr" ? 1 : 0);
  return usable.sort((a, b) => rank(a) - rank(b))[0] || null;
}

// json3 caption document -> [{start, end, text}] in seconds, one entry per sentence or phrase.
function linesFromJson3(doc) {
  const cues = [];
  for (const e of doc.events || []) {
    if (!e.segs) continue;
    const text = cleanText(e.segs.map((s) => s.utf8 || "").join(""));
    if (!text) continue;
    const start = (e.tStartMs || 0) / 1000;
    cues.push({ start, end: start + (e.dDurationMs || 0) / 1000, text });
  }
  cues.sort((a, b) => a.start - b.start);
  // Automatic captions keep each line on screen while the next one is spoken; end it there.
  cues.forEach((c, i) => {
    const next = cues[i + 1];
    if (next && c.end > next.start) c.end = next.start;
    if (c.end <= c.start) c.end = c.start + 0.3;
  });

  const lines = [];
  let cur = null;
  const flush = () => {
    if (cur) lines.push({ start: cur.start, end: cur.end, text: cur.parts.join(" ") });
    cur = null;
  };
  for (const c of cues) {
    if (cur && c.start - cur.end > GAP_S) flush();
    cur = cur || { start: c.start, end: c.end, parts: [] };
    cur.parts.push(c.text);
    cur.end = c.end;
    if (SENTENCE_END.test(c.text) || cur.end - cur.start >= MAX_LINE_S) flush();
  }
  flush();
  return lines;
}

// Drop sound labels like [Music] / [संगीत] and music notes; collapse whitespace.
function cleanText(text) {
  return text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[♪♫]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Seconds this line may take before the next one starts (the dub is sped up to fit it).
function slotFor(lines, i) {
  const line = lines[i];
  const next = lines[i + 1];
  return Math.max(next ? next.start - line.start : line.end - line.start + 1.5, line.end - line.start);
}

if (typeof module !== "undefined") module.exports = { ytLangToCode, pickTrack, linesFromJson3, cleanText, slotFor };
