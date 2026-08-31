# Image text extraction

Vox turns speech into a prompt. This adds a second way in: pull the text
out of a picture. Screenshots of code, forwarded chat images, a photo of a
printed page — the cases where copying the text by hand is the only option
today.

Two engines, because one engine cannot cover both. Rendered text on a flat
screenshot and angled text in a phone photo are different problems, and the
model that handles the second costs a hundred times the download of the one
that handles the first. The user picks per image.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Fast engine | `tesseract.js@7.0.0`, WASM, CPU | Single-threaded in all six core builds, so no COOP/COEP headers. `python3 -m http.server` keeps working. |
| Photo engine | `onnx-community/Florence-2-base-ft` | Runs on the pinned `@huggingface/transformers@3.0.2`. No version bump. |
| Engine choice | Manual, per image, Fast by default | The Photo download is ~357MB. That is the user's call, never automatic. |
| Placement | One `Source` module, `Voice \| Image` tabs | Keeps the page short and the `Transcript \| Prompt` grid untouched. |
| Text destination | Own textarea, explicit push to transcript | Copying text out is the primary case; feeding the shaper is secondary. |
| Session storage | Text + 256px thumbnail + engine name | Text is what you wanted; the thumbnail is what makes an old session recognisable. |
| Tesseract runtime | Vendored into `assets/tesseract/` | Tesseract caches only language data. Vendoring keeps the offline promise whole. |

### Why not bump transformers.js

The current release is 4.2.0 and v4.0.0 rewrote the WebGPU execution
provider — the exact surface the existing Whisper call sits on with
`{ encoder_model: "fp16", decoder_model_merged: "q4" }`. That is not a
hypothetical risk: transformers.js issue #1590, "[webgpu] Whisper encoder
fp16 precision issues", is still open five months after being filed, and
reproduces on `whisper-large-v3-turbo` with a fp16 encoder on WebGPU —
correct on 3.8.1, collapsing from 4.0.0-next.1 onward. The maintainer's
diagnosis is precision loss in the new WebGPU EP. The confirmed damage is
to timestamp segmentation, which this app does not request, but the
diagnosed cause is not timestamp-specific and the fp16 encoder is the
exact input. The only known workaround is a 2.5GB fp32 encoder.

Florence-2 works on 3.0.2, so this feature does not force that decision
and does not take it. The rest of the upgrade is clean — `device: "wasm"`
still resolves, both pipelines still exist, the dtype keys still match
files in the Whisper repo — so if a bump is ever wanted for its own sake,
3.8.1 is the last 3.x and the safe target. Note that the smaller
purpose-built OCR model, `LightOnOCR-2-1B`, requires >=4.0.0, so "best
OCR" and "safe ASR" pull in opposite directions. This design resolves that
by not needing v4 at all.

### Known ceiling on Photo mode

Florence-2's published `vision_encoder.onnx` omits post-forward processing
present in the reference implementation. The conversion script was fixed;
the hub weights have not been re-exported since 2024, and upgrading the
library does not change it. Photo mode is therefore good, not excellent.
If it disappoints in use, the upgrade path is `granite-docling-258M`, which
needs transformers.js ~3.7.x — a minor bump, not the risky major. That is a
later decision informed by real use, not a thing to pre-build.

Tesseract does not support handwriting at any setting. This is documented
behaviour, not a bug to work around, and handwriting is included in the
test material as a known fail so the limit is visible.

## Architecture

One new module in the work column and one new lamp in the rail. Nothing
downstream of the transcript box changes.

```
Source module            [ Voice | Image ]   <- .seg, as the Prompt pane uses
  Voice tab:   #scope canvas + transport      (unchanged)
  Image tab:   drop target + preview
               Paste / Choose / Screen
               extracted-text .lcd textarea
               Copy text / Send to transcript

chain -> Transcript | Prompt                  (unchanged)

rail: Whisper / Shaper / OCR lamps
```

### Units

**`loadImage(blob, how)`** — the single funnel all four inputs reach.
Decodes, normalizes, renders the preview, stores the working canvas, logs
`how` plus source dimensions and byte size. Every input path ends here, so
input handling and OCR never touch each other.

**`normalizeForOcr(bitmap)`** — long edge capped at 2600px; anything under
1000px long edge upscaled 2x. Small images are the most common OCR failure
and the fix costs nothing. Returns the canvas and a description of what it
did, which goes in the status line.

**`extractText(canvas, engine)`** -> `{ text, confidence | null, engine }`.
The only thing the UI calls. Which engine ran is an argument, not a
condition inside the caller.

**`ensureTesseract()` / `ensureFlorence()`** — lazy, cached, guarded by a
`state.*Loading` flag, driving the OCR lamp and the progress bar. Modelled
directly on `ensureWhisper()` (`index.html:1607`). Neither loads at page
load.

**`makeThumb(canvas)`** — 256px long edge, JPEG quality 0.6, ~10-20KB.

### Input paths

| Path | Mechanism | Note |
| --- | --- | --- |
| Paste | `paste` listener, image items off `clipboardData` | The fastest path, and the reason this feature exists. |
| Drop | `dragover`/`drop` on the target | Files, plus a `text/uri-list` fallback for drags from another tab. Best-effort: a cross-origin fetch can fail, and it says so when it does. |
| Choose | hidden `<input type="file" accept="image/*">` | The only path obvious to a first-time user, and the only one that works on touch. |
| Screen | `getDisplayMedia`, one frame to canvas, tracks stopped immediately | Secure-context only, gated like the microphone. |

### Vendored Tesseract runtime

`assets/tesseract/` holds `worker.min.js`, the three LSTM core builds, and
`eng.traineddata`; `workerPath`, `corePath` and `langPath` point at them.
`corePath` is a directory, never a single file, so the SIMD tier selection
still works. All three core builds ship because the tier is chosen at
runtime from feature detection.

This is ~7MB of binaries in git. The alternative was an asterisk on the
one promise the tool makes, on the one input path where the network is not
otherwise needed.

## Data flow

1. An image arrives by any of the four paths and reaches `loadImage`.
2. It is decoded, normalized, and previewed. Nothing has loaded yet.
3. Extract runs the selected engine, loading it on first use.
4. Text lands in the extracted-text textarea, editable — OCR mangles names
   and jargon the same way Whisper does.
5. Copy text takes it to the clipboard. Send to transcript appends it to
   `#raw` exactly as a second voice take appends, and enables Shape.
6. `touchSession()` records `extracted`, `thumb` and `ocrEngine` alongside
   the existing transcript and prompt.

## Persistence

Sessions gain three fields. The rail row shows the thumbnail left of the
existing meta line, and `snippet()` falls back to `extracted` so an
image-only session is not listed as "Empty".

`persistSessions()` (`index.html:1317`) currently halves the session list
until the write fits. Thumbnails make that too blunt — whole sessions
would be lost to make room for pictures. It gains a cheaper first move:
strip `thumb` from the oldest sessions and retry, and only start dropping
sessions if that still does not fit. Text outlives pictures. Whichever
branch runs is reported in the storage notice, with counts, the way the
existing eviction already reports itself.

## Error handling

Say which path was taken. Never pass a bad result off as a good one.

- **Engine will not load** — the OCR lamp goes `off` with the reason, and
  the other engine stays selectable. A failed 357MB download must not cost
  the user the fast path.
- **No text found** — says exactly that, and leaves the previous extraction
  in place rather than blanking the box. An empty result is a result.
- **Low confidence** — mean confidence appears in the status line as a
  number; under ~60% it warns that the text is unreliable and suggests
  Photo mode. Same self-check ethos as the existing bracketed-placeholder
  and echoed-instruction warnings.
- **Insecure context** — the Screen button disables itself and points at
  the existing `#insecure` notice instead of failing silently.
- **Undecodable or oversized image** — caught at decode, reported with the
  actual dimensions and size.

## Testing

No test framework in the repo; `samples.md` is the established convention.
It gains an extraction section with four reference images committed to
`assets/`, each with what a pass and a fail look like, mirroring the six
dictation scripts:

1. A code screenshot — exact preservation, including punctuation.
2. A dark-mode low-contrast screenshot — the normalize step earning its
   place.
3. An angled photo of a printed page — Fast should struggle, Photo should
   not.
4. Handwriting — known fail on Fast, documented as a limit.

## Out of scope

PDFs, multi-page documents, batch extraction, layout or table
reconstruction, languages other than English, and re-running OCR on an old
session with a different engine (which is what storing the full image
would have bought, and it is not worth the quota).

## To verify during implementation

- The output flags needed to get per-word confidence from `worker.recognize`
  in v7, since v6 disabled all non-`text` outputs by default.
- Florence-2 dtype mix per module. `embed_tokens_q4` is byte-identical to
  fp32 in this repo, so `q4` there buys nothing — use fp16 or int8.
- The exact filename and gzip convention `langPath` expects for a vendored
  `eng.traineddata`, since the CDN serves it gzipped and v7 changed the
  default `langPath` to an npm-hosted directory.
