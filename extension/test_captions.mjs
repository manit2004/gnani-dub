// Unit tests for captions.js: node extension/test_captions.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { ytLangToCode, pickTrack, linesFromJson3, slotFor } = createRequire(import.meta.url)("./captions.js");

assert.equal(ytLangToCode("bn"), "bn-IN");
assert.equal(ytLangToCode("en-US"), "en-IN");
assert.equal(ytLangToCode("or"), "od-IN");

const sources = ["en-IN", "bn-IN", "hi-IN"];
const tracks = [
  { languageCode: "bn", kind: "asr" },
  { languageCode: "hi", kind: "" },
  { languageCode: "bn", kind: "" },
  { languageCode: "fr", kind: "" },
];
assert.equal(pickTrack(tracks, "hi-IN", sources).languageCode, "bn"); // manual, not the target
assert.equal(pickTrack(tracks, "hi-IN", sources).kind, "");
assert.equal(pickTrack([{ languageCode: "fr", kind: "" }], "hi-IN", sources), null);

// Hand-written captions: cues joined until a sentence ends.
const manual = {
  events: [
    { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "আজ সকালে" }] },
    { tStartMs: 2000, dDurationMs: 1500, segs: [{ utf8: "বৃষ্টি পড়ছে।" }] },
    { tStartMs: 5000, dDurationMs: 1000, segs: [{ utf8: "[সঙ্গীত]" }] },
    { tStartMs: 7000, dDurationMs: 2000, segs: [{ utf8: "তুমি কেমন\nআছো?" }] },
  ],
};
assert.deepEqual(linesFromJson3(manual), [
  { start: 0, end: 3.5, text: "আজ সকালে বৃষ্টি পড়ছে।" },
  { start: 7, end: 9, text: "তুমি কেমন আছো?" },
]);

// Automatic captions: overlapping windows, no punctuation, word segments, newline events.
const asr = {
  events: [
    { tStartMs: 0, dDurationMs: 100000, id: 1 },
    { tStartMs: 500, dDurationMs: 6000, segs: [{ utf8: "aaj" }, { utf8: " subah", tOffsetMs: 400 }] },
    { tStartMs: 3000, dDurationMs: 6000, aAppend: 1, segs: [{ utf8: "\n" }] },
    { tStartMs: 3000, dDurationMs: 7000, segs: [{ utf8: "baarish hui" }] },
    { tStartMs: 12000, dDurationMs: 2000, segs: [{ utf8: "phir dhoop" }] },
  ],
};
const lines = linesFromJson3(asr);
assert.deepEqual(lines.map((l) => l.text), ["aaj subah baarish hui", "phir dhoop"]);
assert.equal(lines[0].start, 0.5);
assert.equal(lines[0].end, 10); // ended by the 2 s pause before "phir dhoop"

// A long unpunctuated stream is cut at MAX_LINE_S.
const stream = { events: Array.from({ length: 20 }, (_, k) => ({ tStartMs: k * 1000, dDurationMs: 1000, segs: [{ utf8: `w${k}` }] })) };
assert.ok(linesFromJson3(stream).every((l) => l.end - l.start <= 9));

assert.equal(slotFor(lines, 0), 11.5); // until the next line starts
assert.equal(slotFor(lines, 1), 3.5); // last line: its own length + 1.5 s
console.log("captions.js: all tests passed");
