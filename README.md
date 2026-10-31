# gnani-dub

`gnani-dub` is a Chrome extension that dubs YouTube videos into Indian languages as they play, using [Gnani](https://docs.gnani.ai) for speech and [Sarvam](https://docs.sarvam.ai) for translation. Built for Gnani's [Great Indian AI Internship Challenge](https://www.gnani.ai/internship).

**Solution pitch (1 page):** [docs/pitch.pdf](docs/pitch.pdf)

## Requirements

- [uv](https://docs.astral.sh/uv/)
- ffmpeg
- Chrome
- Gnani and Sarvam API keys

## Setup

Start the local server (it holds the API keys and caches results):

```sh
cd server
cp .env.example .env      # add GNANI_KEY and SARVAM_KEY
uv run gnani-dub-server   # 127.0.0.1:8000
```

Then load the extension: open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick the `extension/` folder.

## Usage

Open a YouTube video, click **DUB** in the player controls, pick a language and press **Start dubbing**.

Dubs into Hindi, Bengali, Tamil, Telugu, Kannada, Malayalam, Marathi, Gujarati and Punjabi, from English or any Indian language Sarvam supports.

> **Note:** after reloading the extension, refresh open YouTube tabs too, or the dub won't start.

## How it works

| Video | What happens |
|-------|--------------|
| Has captions | Captions are translated and spoken a little ahead of playback, and each clip plays when the video reaches its line. If a clip isn't ready, the video waits for it. |
| No captions | The audio is streamed to Gnani's streaming speech-to-text. The video pauses after each sentence while it's translated and spoken, then carries on. |

**Clone the speaker's voice** (off by default) records about 15 s of the original speech and switches the dub to a Gnani clone of that voice. Only use it on videos you made or have permission to use.

YouTube often blocks direct caption downloads, so the extension falls back to the player's own copy, then the video's transcript, and finally to listening.

## Gnani streaming STT notes

- `language_code` as a list (`hi-IN,en-IN`) was rejected on our account — we use `indic-auto`.
- With the default `x-min-silence-ms` (500), Prisma v3.0 sometimes dropped the last sentence of a segment. 300 fixes it.

## Limitations

- Without captions, the video stops after every sentence, so watching takes longer.
- One voice for everyone in the video.
- Relies on YouTube internals that can change.
