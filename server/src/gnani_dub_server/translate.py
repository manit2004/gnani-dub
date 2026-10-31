"""Translation between English and Indian languages with Sarvam's translate API."""

from concurrent.futures import ThreadPoolExecutor

import requests

from .gnani import _request, load_key

API = "https://api.sarvam.ai/translate"
MODEL = "sarvam-translate:v1"
MAX_CHARS = 1800  # the model takes up to 2000 characters per request

# Source languages we accept (Gnani's codes, which Sarvam shares). English is translated too.
SOURCES = {"en-IN", "bn-IN", "hi-IN", "ta-IN", "te-IN", "kn-IN", "ml-IN", "mr-IN", "gu-IN", "pa-IN", "od-IN"}


class Translator:
    def __init__(self):
        self.key = load_key("SARVAM_KEY")
        self.session = requests.Session()  # keep the connection open between requests

    def translate_sentences(self, sentences, src, tgt):
        """Translate a list of sentences, returning one translation per sentence.

        Sentences are sent one per line, several per request, so the model sees their context,
        and the requests run in parallel. sarvam-translate keeps the line breaks; if a batch
        comes back with a different number of lines, its sentences are retried one at a time.
        """

        def run(batch):
            lines = self._call("\n".join(batch), src, tgt).split("\n")
            lines = [l.strip() for l in lines if l.strip()]
            if len(lines) != len(batch):
                lines = [self._call(s, src, tgt).strip() for s in batch]
            return lines

        with ThreadPoolExecutor(max_workers=4) as pool:
            return [line for lines in pool.map(run, _batches(sentences)) for line in lines]

    def _call(self, text, src, tgt):
        r = _request(
            "POST",
            API,
            session=self.session,
            headers={"api-subscription-key": self.key},
            json={
                "input": text,
                "source_language_code": src,
                "target_language_code": tgt,
                "model": MODEL,
                "numerals_format": "native",
            },
            timeout=60,
        )
        if r.status_code != 200:
            raise RuntimeError(f"Sarvam translate failed ({r.status_code}): {r.text[:300]}")
        return r.json()["translated_text"]


def _batches(sentences):
    batch, size = [], 0
    for s in sentences:
        if batch and size + len(s) + 1 > MAX_CHARS:
            yield batch
            batch, size = [], 0
        batch.append(s)
        size += len(s) + 1
    if batch:
        yield batch

