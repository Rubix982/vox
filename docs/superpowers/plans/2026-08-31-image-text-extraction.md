# Image Text Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Vox pull text out of an image — screenshots, forwarded chat pictures, photos of printed pages — alongside its existing voice-to-prompt path.

**Architecture:** One new `Source` module in `index.html` with a `Voice | Image` tab switch replacing the current `Capture` module. Four input paths (paste, drop, file picker, screen grab) funnel into one `loadImage()`, which normalizes to a canvas. One `extractText(canvas, engine)` call sits in front of two lazily-loaded engines: Tesseract (WASM, CPU, vendored locally, default) and Florence-2 (WebGPU, via the transformers.js already in the file). Extracted text lands in its own editable textarea with `Copy text` and `Send to transcript` actions. Nothing downstream of the transcript box changes.

**Tech Stack:** Vanilla ES modules in a single HTML file, no build step. `tesseract.js@7.0.0` (vendored under `assets/tesseract/`), `@huggingface/transformers@3.0.2` (already imported, CDN), Canvas 2D, `getDisplayMedia`, IndexedDB (Tesseract's own language cache), `localStorage`.

**Spec:** `docs/superpowers/specs/2026-08-31-image-text-extraction-design.md`

## Global Constraints

- **Never bump `@huggingface/transformers` from `3.0.2`.** Line 914 of `index.html` stays exactly as it is. transformers.js issue #1590 is open and breaks this app's Whisper config (`device: "webgpu"` with `encoder_model: "fp16"`) from 4.0.0 onward. Florence-2 works on 3.0.2.
- **No build step.** Everything is an ES module import or a vendored file served as-is. `python3 -m http.server 43869` must remain the only command needed.
- **No new network dependency at runtime.** Tesseract's entry script, worker, WASM core and language data are all vendored under `assets/tesseract/` and referenced by relative path.
- **Tesseract version is `7.0.0`.** Do not resolve `tesseract.js-core` by `@latest` — the npm `latest` tag points at 6.1.2, published ten minutes after 7.0.0. Pin `7.0.0` explicitly in every URL.
- **Photo mode requires WebGPU.** Florence-2 on WASM would be a ~1.09GB fp32 download. Without WebGPU the Photo option is disabled with a reason, not offered and then failed.
- **Existing code style:** 2-space indent, `$("id")` for element lookup, `state.*` for mutable state, block comments that explain *why*. Match it.
- **Never log or store image content anywhere off-device.** No telemetry, no uploads. This is the tool's only promise.

---

### Task 1: Self-test harness

`index.html` has no test runner and its functions are not importable. The tests ship inside the file and run at `?test=1`, rendering an overlay. This is what every later task's "run the tests" step uses.

**Files:**
- Modify: `index.html` — add the harness at the end of the module script (after all function definitions, before the init calls at the bottom)

**Interfaces:**
- Consumes: nothing
- Produces: `test(name, fn)` to register a case; `eq(actual, expected, msg)` and `ok(cond, msg)` assertions; `runTests()` which renders the overlay. Later tasks call `test(...)` only.

- [ ] **Step 1: Find the insertion point**

Run: `grep -n "^lamps.whisper.btn.addEventListener\|^drawScope()\|^renderSessions()" index.html | tail -5`

The harness goes after the last function definition and before the bottom-of-file init calls. Note the line number.

- [ ] **Step 2: Write the harness**

Insert into the module script:

```js
/* ── Self-test ─────────────────────────────────────────────────
   Vox is one file with no build step, so there is nowhere for a
   test runner to live. The tests ship with the app and run at
   ?test=1, which is also the only way to exercise the pure
   geometry and eviction helpers without a browser harness. */
const TESTS = [];
function test(name, fn) { TESTS.push({ name, fn }); }

function ok(cond, msg) {
  if (!cond) throw new Error(msg || "expected truthy");
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || "mismatch"}: got ${a}, want ${b}`);
}

async function runTests() {
  const lines = [];
  let pass = 0, fail = 0;
  for (const t of TESTS) {
    try {
      await t.fn();
      pass++; lines.push(`  ok   ${t.name}`);
    } catch (e) {
      fail++; lines.push(`  FAIL ${t.name}\n         ${e.message}`);
    }
  }
  const box = document.createElement("pre");
  box.style.cssText = "position:fixed;inset:0;z-index:9999;margin:0;padding:24px;" +
    "overflow:auto;background:#0d0f0a;color:#d8dcc8;font:12px/1.6 ui-monospace,monospace;white-space:pre-wrap";
  box.textContent = [`${pass} passed, ${fail} failed`, "", ...lines].join("\n");
  document.body.appendChild(box);
  console.log(`[vox tests] ${pass} passed, ${fail} failed`);
}

/* The module suspends on the top-level `await probeGPU()` at line 955, and
   the document fires `load` while it is suspended — so by the time this
   runs, `load` has usually already gone. Check readyState rather than
   trusting the event to still be coming. */
if (new URLSearchParams(location.search).has("test")) {
  if (document.readyState === "complete") runTests();
  else addEventListener("load", runTests);
}
```

- [ ] **Step 3: Register one smoke test to prove the harness works**

```js
test("harness runs", () => { eq(1 + 1, 2, "arithmetic"); });
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `python3 -m http.server 43869` then open `http://localhost:43869/?test=1`

Expected: a dark overlay reading `1 passed, 0 failed` with `ok   harness runs`.

- [ ] **Step 5: Prove a failure is actually reported**

Temporarily change the smoke test to `eq(1 + 1, 3, "arithmetic")`, reload, and confirm it reads `1 passed, 0 failed` -> `0 passed, 1 failed` with the message `arithmetic: got 2, want 3`. Then change it back to `2` and reload to confirm green again.

A test harness that cannot fail is worse than none. Do not skip this step.

- [ ] **Step 6: Confirm the app still works normally**

Open `http://localhost:43869/` (no query string). Expected: the normal Vox UI, no overlay, nothing in the console from the harness.

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "test: add in-file self-test harness behind ?test=1"
```

---

### Task 2: OCR image geometry

The single biggest lever on OCR accuracy is input resolution, and the two failure modes are opposite: an oversized photo wastes time and memory, an undersized screenshot simply cannot be read. This task is the pure arithmetic, tested in isolation.

**Files:**
- Modify: `index.html` — add near the other pure helpers (`words`, `snippet`, around line 1311)
- Test: `index.html` (`?test=1`)

**Interfaces:**
- Consumes: `test`, `eq` (Task 1)
- Produces: `ocrTargetSize(w, h)` -> `{ w, h, how }` where `how` is a human-readable sentence for the status line. Task 4 calls this from `normalizeForOcr`.

- [ ] **Step 1: Write the failing tests**

```js
test("ocrTargetSize leaves a well-sized image alone", () => {
  eq(ocrTargetSize(1600, 900), { w: 1600, h: 900, how: "used at 1600x900" });
});
test("ocrTargetSize caps the long edge at 2600", () => {
  eq(ocrTargetSize(5200, 2600), { w: 2600, h: 1300, how: "downscaled 5200x2600 to 2600x1300" });
});
test("ocrTargetSize caps on height when the image is tall", () => {
  eq(ocrTargetSize(1000, 5200), { w: 500, h: 2600, how: "downscaled 1000x5200 to 500x2600" });
});
test("ocrTargetSize doubles a small image", () => {
  eq(ocrTargetSize(400, 300), { w: 800, h: 600, how: "upscaled 400x300 to 800x600" });
});
test("ocrTargetSize treats 1000 as big enough", () => {
  eq(ocrTargetSize(1000, 200), { w: 1000, h: 200, how: "used at 1000x200" });
});
test("ocrTargetSize survives a 1px image", () => {
  eq(ocrTargetSize(1, 1), { w: 2, h: 2, how: "upscaled 1x1 to 2x2" });
});
```

- [ ] **Step 2: Run them to verify they fail**

Open `http://localhost:43869/?test=1`

Expected: 6 failures, each reading `ocrTargetSize is not defined`.

- [ ] **Step 3: Implement it**

```js
/* Resolution is most of OCR accuracy. Tesseract wants roughly
   300dpi-equivalent text, so a small screenshot is upscaled rather
   than fed in at its native size — the commonest failure, and the
   fix is free. Oversized photos are capped so a 12MP phone shot
   does not spend a minute in the WASM engine for no gain. */
const OCR_MAX_EDGE = 2600;
const OCR_MIN_EDGE = 1000;

function ocrTargetSize(w, h) {
  const long = Math.max(w, h);
  if (long > OCR_MAX_EDGE) {
    const k = OCR_MAX_EDGE / long;
    const out = { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
    return { ...out, how: `downscaled ${w}x${h} to ${out.w}x${out.h}` };
  }
  if (long < OCR_MIN_EDGE) {
    const out = { w: w * 2, h: h * 2 };
    return { ...out, how: `upscaled ${w}x${h} to ${out.w}x${out.h}` };
  }
  return { w, h, how: `used at ${w}x${h}` };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Open `http://localhost:43869/?test=1`

Expected: `7 passed, 0 failed` (six new plus the harness smoke test).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: add OCR input geometry helper with tests"
```

---

### Task 3: Thumbnail geometry and encoding

Sessions store a small JPEG so an old extraction is recognisable in the rail. The geometry is pure and tested; the encoding is checked by asserting on a real canvas.

**Files:**
- Modify: `index.html` — beside `ocrTargetSize`
- Test: `index.html` (`?test=1`)

**Interfaces:**
- Consumes: `test`, `eq`, `ok` (Task 1)
- Produces: `thumbTargetSize(w, h)` -> `{ w, h }`; `makeThumb(canvas)` -> JPEG data URL string. Task 9 stores the result on the session record.

- [ ] **Step 1: Write the failing tests**

```js
test("thumbTargetSize caps the long edge at 256", () => {
  eq(thumbTargetSize(1024, 512), { w: 256, h: 128 });
});
test("thumbTargetSize caps on height for a tall image", () => {
  eq(thumbTargetSize(512, 1024), { w: 128, h: 256 });
});
test("thumbTargetSize never upscales", () => {
  eq(thumbTargetSize(100, 80), { w: 100, h: 80 });
});
test("thumbTargetSize keeps at least one pixel", () => {
  eq(thumbTargetSize(4000, 3), { w: 256, h: 1 });
});
test("makeThumb returns a small JPEG data URL", () => {
  const c = document.createElement("canvas");
  c.width = 1200; c.height = 600;
  const g = c.getContext("2d");
  g.fillStyle = "#345"; g.fillRect(0, 0, 1200, 600);
  const url = makeThumb(c);
  ok(url.startsWith("data:image/jpeg;base64,"), `wrong prefix: ${url.slice(0, 32)}`);
  ok(url.length < 60000, `thumb too big: ${url.length} chars`);
});
```

- [ ] **Step 2: Run them to verify they fail**

Open `http://localhost:43869/?test=1`

Expected: 5 new failures naming `thumbTargetSize` / `makeThumb` as undefined.

- [ ] **Step 3: Implement it**

```js
/* A session row shows what the image was, so the thumbnail only has
   to be recognisable, not readable — 256px of JPEG is 10-20KB, which
   60 sessions can afford inside the localStorage budget. */
const THUMB_EDGE = 256;

function thumbTargetSize(w, h) {
  const long = Math.max(w, h);
  if (long <= THUMB_EDGE) return { w, h };
  const k = THUMB_EDGE / long;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

function makeThumb(canvas) {
  const { w, h } = thumbTargetSize(canvas.width, canvas.height);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(canvas, 0, 0, w, h);
  return c.toDataURL("image/jpeg", 0.6);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Expected: `12 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: add session thumbnail helpers with tests"
```

---

### Task 4: Source module markup and the Voice | Image switch

The existing `Capture` module becomes `Source` with a segmented switch. Reuse the `.seg` / `.seg__btn` classes the Prompt pane already uses for Formatted/Markdown so no new CSS idiom is introduced.

**Files:**
- Modify: `index.html:786-816` (the `Capture` section markup)
- Modify: `index.html` — CSS block, add `.drop` styles near the existing `.scope` rules
- Modify: `index.html` — `KEY` object around line 967, add a key for the remembered tab
- Test: manual, plus one registered test for the tab-persistence helper

**Interfaces:**
- Consumes: `store` (existing), `$` (existing)
- Produces: element ids `#src-voice`, `#src-image`, `#voice-body`, `#image-body`, `#drop`, `#drop-hint`, `#img-preview`, `#ocr-engine`, `#btn-paste`, `#btn-choose`, `#btn-screen`, `#btn-extract`, `#btn-img-clear`, `#file-input`, `#ocr-progress`, `#extract-error`, `#extract-state`, `#extracted`, `#extracted-count`, `#btn-copy-text`, `#btn-to-transcript`. Functions `sourceTab()` -> `"voice" | "image"` and `setSourceTab(which)`.

- [ ] **Step 1: Rename the section and add the switch**

Change the `Capture` section bar (`index.html:788-794`) to:

```html
  <!-- ── Source ────────────────────────────────────────────── -->
  <section class="module" aria-labelledby="silk-capture">
    <div class="module__bar">
      <span class="silk silk--key" id="silk-capture">Source</span>
      <span class="meta" id="capture-state" role="status">Ready</span>
      <div class="seg" role="group" aria-label="Input source">
        <button id="src-voice" class="seg__btn" type="button" aria-pressed="true">Voice</button>
        <button id="src-image" class="seg__btn" type="button" aria-pressed="false">Image</button>
      </div>
      <label class="sr-only" for="mic-select">Microphone</label>
      <select id="mic-select" class="push" title="Microphone"><option>Default microphone</option></select>
      <label class="sr-only" for="ocr-engine">Extraction engine</label>
      <select id="ocr-engine" class="push" hidden title="Which engine reads the image">
        <option value="fast">Fast — screenshots</option>
        <option value="photo">Photo — angled or real-world</option>
      </select>
    </div>
```

- [ ] **Step 2: Wrap the existing voice controls and add the image body**

Wrap the existing `.scope` div, `.transport` div, `#whisper-progress` and `#capture-error` in `<div id="voice-body">`, then add the image body directly after it, still inside the same `<section>`:

```html
    <div id="image-body" hidden>
      <div class="drop" id="drop" tabindex="0" role="button"
           aria-label="Drop an image here, or paste one">
        <img id="img-preview" alt="" hidden>
        <div class="drop__hint" id="drop-hint">
          Drop an image, paste with <kbd>⌘</kbd><kbd>V</kbd>, or choose one
        </div>
      </div>

      <div class="transport">
        <button id="btn-extract" class="lit" type="button" disabled>Extract text</button>
        <button id="btn-paste" type="button">Paste</button>
        <button id="btn-choose" type="button">Choose…</button>
        <button id="btn-screen" type="button">Screen</button>
        <span class="meta push" id="extract-state" role="status"></span>
        <button id="btn-img-clear" class="flat" type="button">Clear</button>
      </div>

      <input type="file" id="file-input" accept="image/*" hidden>
      <div class="progress" id="ocr-progress" hidden><div class="bar"></div></div>

      <div class="lcd-frame">
        <label class="sr-only" for="extracted">Extracted text</label>
        <textarea id="extracted" class="lcd lcd--mono" spellcheck="false"
          placeholder="The text found in the image appears here. Editable — OCR mangles names and jargon the same way Whisper does."></textarea>
      </div>

      <div class="actions">
        <button id="btn-copy-text" class="lit" type="button" disabled>Copy text</button>
        <button id="btn-to-transcript" type="button" disabled>Send to transcript</button>
        <span class="meta push" id="extracted-count">0 words</span>
      </div>

      <p class="notice" id="extract-error" role="alert" hidden></p>
    </div>
  </section>
```

- [ ] **Step 3: Add the drop-target CSS**

Next to the existing `.scope` rules, matching their border and radius idiom:

```css
  .drop {
    position: relative; display: grid; place-items: center;
    min-height: 190px; padding: 12px; margin-bottom: 12px;
    border: 1px dashed #3a4030; border-radius: 6px; background: #14170f;
    cursor: pointer; transition: border-color .12s, background .12s;
  }
  .drop:hover, .drop:focus-visible { border-color: #5d6748; outline: none; }
  .drop.is-over { border-color: var(--lit, #c9d17a); background: #1b1f13; }
  .drop__hint { color: #8e9678; font-size: 12px; text-align: center; }
  .drop img { max-width: 100%; max-height: 320px; border-radius: 4px; display: block; }
```

- [ ] **Step 4: Add the tab state and wire the switch**

Add `srcTab: "vox.srcTab.v1"` to the `KEY` object, then near the other view-toggle code:

```js
/* The two sources hold their own state independently — a loaded
   waveform and a loaded image both survive a tab switch, because
   losing either one to a stray click would be infuriating. */
function sourceTab() {
  return store.get(KEY.srcTab, "voice") === "image" ? "image" : "voice";
}

function setSourceTab(which, { remember = true } = {}) {
  const image = which === "image";
  $("voice-body").hidden = image;
  $("image-body").hidden = !image;
  $("mic-select").hidden = image;
  $("ocr-engine").hidden = !image;
  $("src-voice").setAttribute("aria-pressed", String(!image));
  $("src-image").setAttribute("aria-pressed", String(image));
  if (remember) store.set(KEY.srcTab, image ? "image" : "voice");
}

$("src-voice").addEventListener("click", () => setSourceTab("voice"));
$("src-image").addEventListener("click", () => setSourceTab("image"));
```

Call `setSourceTab(sourceTab(), { remember: false })` alongside the other init calls at the bottom of the file.

- [ ] **Step 5: Stop recording from being triggered from the image side**

Find the global `keydown` handler that implements `Space` and `P`. Confirm it already ignores keys typed into a field; if the guard is a tag check, extend it so `#extracted` is covered:

Run: `grep -n "keydown" index.html`

The guard must return early when `e.target` is an `input`, `textarea`, `select` or `[contenteditable]`. Verify by typing a space into the extracted-text box and confirming recording does **not** start.

- [ ] **Step 6: Manual verification**

Open `http://localhost:43869/`:
- The module is titled `Source` and shows `Voice | Image`
- Voice is selected, the scope and transport look exactly as before, the mic select is visible, the engine select is not
- Clicking `Image` swaps to the drop target, hides the mic select, shows the engine select defaulting to `Fast — screenshots`
- Reload — the Image tab is still selected
- Click `Voice`, reload — Voice is selected
- Record a short take on Voice, switch to Image and back — the waveform and transcript are untouched
- Type a space into the extracted-text box — recording does not start

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat: turn Capture into a Source module with Voice/Image tabs"
```

---

### Task 5: The four input paths and the loadImage funnel

Every way an image can arrive ends in one function, so input handling and OCR never learn about each other.

**Files:**
- Modify: `index.html` — new functions after `makeThumb`; event wiring near the other listeners
- Modify: `index.html` — `state` object around line 1140, add `image: null`

**Interfaces:**
- Consumes: `ocrTargetSize` (Task 2), element ids (Task 4), `GPU` and `setNotice` (existing)
- Produces: `state.image` = `{ canvas, how, sourceW, sourceH, bytes }` or `null`; `loadImage(blob, how)`; `normalizeForOcr(bitmap)` -> `{ canvas, how }`; `clearImage()`

- [ ] **Step 1: Write the failing test for normalizeForOcr**

```js
test("normalizeForOcr upscales a small bitmap onto a canvas", async () => {
  const c = document.createElement("canvas");
  c.width = 300; c.height = 200;
  c.getContext("2d").fillRect(0, 0, 300, 200);
  const bmp = await createImageBitmap(c);
  const out = normalizeForOcr(bmp);
  eq([out.canvas.width, out.canvas.height], [600, 400], "canvas size");
  eq(out.how, "upscaled 300x200 to 600x400", "description");
});
```

- [ ] **Step 2: Run it to verify it fails**

Expected: `normalizeForOcr is not defined`.

- [ ] **Step 3: Implement the funnel**

```js
/* Four ways in — paste, drop, picker, screen grab — all land here,
   so the engines never learn where an image came from. `how` is
   carried through to the log and the status line: knowing an
   extraction came from a screen grab rather than a file explains a
   lot when the result is bad. */
function normalizeForOcr(bitmap) {
  const { w, h, how } = ocrTargetSize(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext("2d");
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(bitmap, 0, 0, w, h);
  return { canvas, how };
}

async function loadImage(blob, how) {
  setNotice(extractError, "");
  if (!blob || !blob.type.startsWith("image/")) {
    setNotice(extractError, `That ${blob ? blob.type || "file" : "item"} is not an image Vox can read.`);
    return;
  }
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch (e) {
    setNotice(extractError, `That image could not be decoded (${blob.type}, ${Math.round(blob.size / 1024)}KB).`);
    console.warn("[vox] image decode failed", { how, type: blob.type, bytes: blob.size, error: e.message });
    return;
  }

  const { canvas, how: sizing } = normalizeForOcr(bmp);
  state.image = { canvas, how, sourceW: bmp.width, sourceH: bmp.height, bytes: blob.size };
  bmp.close?.();

  imgPreview.src = canvas.toDataURL("image/png");
  imgPreview.hidden = false;
  dropHint.hidden = true;
  btnExtract.disabled = false;
  extractState.textContent = `${how} · ${sizing}`;
  console.log("[vox] image loaded", { how, sizing, bytes: blob.size, type: blob.type });
}

function clearImage() {
  state.image = null;
  imgPreview.hidden = true;
  imgPreview.removeAttribute("src");
  dropHint.hidden = false;
  btnExtract.disabled = true;
  extractState.textContent = "";
  setNotice(extractError, "");
}
```

Add the element lookups beside the other `$(...)` constants:

```js
const drop = $("drop"), dropHint = $("drop-hint"), imgPreview = $("img-preview");
const btnExtract = $("btn-extract"), extractState = $("extract-state");
const extractError = $("extract-error"), ocrProgress = $("ocr-progress");
const extracted = $("extracted"), extractedCount = $("extracted-count");
const btnCopyText = $("btn-copy-text"), btnToTranscript = $("btn-to-transcript");
```

- [ ] **Step 4: Run the test to verify it passes**

Expected: `13 passed, 0 failed`.

- [ ] **Step 5: Wire all four inputs**

```js
/* Paste is the path this feature exists for — a screenshot you just
   took, or a picture copied out of a chat — so it listens on the
   document and only bows out when the user is typing into a field. */
addEventListener("paste", (e) => {
  if (sourceTab() !== "image") return;
  const t = e.target;
  if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith("image/"));
  if (!item) return;
  e.preventDefault();
  loadImage(item.getAsFile(), "pasted");
});

$("btn-paste").addEventListener("click", async () => {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find(t => t.startsWith("image/"));
      if (type) return loadImage(await item.getType(type), "pasted");
    }
    setNotice(extractError, "No image on the clipboard. Copy one, then try again.");
  } catch (e) {
    setNotice(extractError, `This browser would not hand over the clipboard (${e.name}). Press ⌘V or Ctrl+V instead.`);
  }
});

for (const ev of ["dragenter", "dragover"]) {
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("is-over"); });
}
for (const ev of ["dragleave", "drop"]) {
  drop.addEventListener(ev, () => drop.classList.remove("is-over"));
}

drop.addEventListener("drop", async (e) => {
  e.preventDefault();
  const file = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith("image/"));
  if (file) return loadImage(file, "dropped");

  /* A drag from another browser tab carries a URL, not a file. Best
     effort: the fetch can fail on CORS or offline, and saying so beats
     a dead drop target. */
  const url = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain");
  if (!url) return setNotice(extractError, "Nothing image-shaped in that drop.");
  try {
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadImage(await res.blob(), "dragged from another tab");
  } catch (err) {
    setNotice(extractError, `That image is on another site and it refused the request (${err.message}). Save it and choose the file instead.`);
    console.warn("[vox] cross-origin image drop failed", { url, error: err.message });
  }
});

const fileInput = $("file-input");
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) loadImage(f, `chose ${f.name}`);
  fileInput.value = "";
});

drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
$("btn-choose").addEventListener("click", () => fileInput.click());

/* Screen capture is a secure-context feature, exactly like the
   microphone, so it disables itself for the same reason rather than
   failing at the click. */
$("btn-screen").addEventListener("click", async () => {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const track = stream.getVideoTracks()[0];
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise(r => requestAnimationFrame(r));
    const c = document.createElement("canvas");
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext("2d").drawImage(video, 0, 0);
    track.stop();
    const blob = await new Promise(r => c.toBlob(r, "image/png"));
    await loadImage(blob, "grabbed from screen");
  } catch (e) {
    if (e.name !== "NotAllowedError") {
      setNotice(extractError, `Screen capture failed (${e.name}).`);
      console.warn("[vox] getDisplayMedia failed", { error: e.name });
    }
  } finally {
    stream?.getTracks().forEach(t => t.stop());
  }
});

$("btn-img-clear").addEventListener("click", clearImage);
```

Add `image: null` to the `state` object, and in the init section disable Screen when the context is insecure:

```js
if (!navigator.mediaDevices?.getDisplayMedia) {
  $("btn-screen").disabled = true;
  $("btn-screen").title = "Screen capture needs a secure context — see the note at the foot of the page";
}
```

- [ ] **Step 6: Manual verification of every path**

On the Image tab:
- Copy a screenshot, press `⌘V` -> preview appears, status reads `pasted · used at WxH`, Extract enables
- Click `Paste` with an image on the clipboard -> same result
- Drag a PNG from Finder onto the target -> border highlights on hover, preview appears, status reads `dropped · …`
- Click the target -> file picker opens; choose an image -> status reads `chose <filename> · …`
- Click `Screen`, pick a window -> preview appears, status reads `grabbed from screen · …`, and the browser's sharing indicator stops immediately
- Drop a `.txt` file -> `not an image Vox can read`, no preview
- Click `Clear` -> preview gone, hint back, Extract disabled
- Drop a small image (under 1000px) -> status says `upscaled`
- Drop a large photo (over 2600px) -> status says `downscaled`

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat: add paste, drop, picker and screen-grab image inputs"
```

---

### Task 6: Vendor the Tesseract runtime

Tesseract caches only its language data in IndexedDB; its entry script, worker and WASM core would be re-fetched from a CDN every session. Vendoring all four keeps the offline promise whole.

**Files:**
- Create: `assets/tesseract/tesseract.esm.min.js`
- Create: `assets/tesseract/worker.min.js`
- Create: `assets/tesseract/core/` (the LSTM WASM builds)
- Create: `assets/tesseract/lang/eng.traineddata.gz`
- Modify: `.gitattributes` (create if absent) to mark the WASM and traineddata as binary

**Interfaces:**
- Consumes: nothing
- Produces: the four vendored paths that Task 7 configures Tesseract with

- [ ] **Step 1: Create the directories**

```bash
mkdir -p assets/tesseract/core assets/tesseract/lang
```

- [ ] **Step 2: Fetch the entry script and worker**

```bash
curl -fsSL -o assets/tesseract/tesseract.esm.min.js \
  https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.esm.min.js
curl -fsSL -o assets/tesseract/worker.min.js \
  https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js
ls -la assets/tesseract/
```

Expected: `tesseract.esm.min.js` present, `worker.min.js` roughly 110KB.

- [ ] **Step 3: List the core builds rather than guessing their names**

```bash
curl -fsSL 'https://data.jsdelivr.com/v1/packages/npm/tesseract.js-core@7.0.0?structure=flat' \
  | python3 -c "import json,sys; [print(f['name']) for f in json.load(sys.stdin)['files']]"
```

Note every filename containing `lstm` and **not** containing `legacy`. There should be three tiers (scalar, SIMD, relaxed SIMD), each a `.wasm.js` and possibly a companion `.wasm`.

- [ ] **Step 4: Fetch exactly those files**

```bash
curl -fsSL 'https://data.jsdelivr.com/v1/packages/npm/tesseract.js-core@7.0.0?structure=flat' \
  | python3 -c "
import json,sys
for f in json.load(sys.stdin)['files']:
    n = f['name']
    if 'lstm' in n and 'legacy' not in n: print(n)
" | while read -r p; do
      curl -fsSL --create-dirs -o "assets/tesseract/core${p}" \
        "https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0${p}"
    done
find assets/tesseract/core -type f | sort
du -sh assets/tesseract/core
```

Expected: the LSTM builds present, roughly 4MB total.

- [ ] **Step 5: Fetch the English language data**

v7 moved the default `langPath` to an npm-hosted directory. Take it from there, not from `tessdata.projectnaptha.com`, which 404s for this tier.

```bash
curl -fsSL -o assets/tesseract/lang/eng.traineddata.gz \
  https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz
ls -la assets/tesseract/lang/
file assets/tesseract/lang/eng.traineddata.gz
```

Expected: roughly 2.9MB, and `file` reports gzip compressed data. If the version-pinned URL 404s, resolve the current one:

```bash
curl -fsSL 'https://data.jsdelivr.com/v1/packages/npm/@tesseract.js-data/eng?structure=flat' | head -40
```

- [ ] **Step 6: Mark the binaries as binary**

```bash
cat >> .gitattributes <<'ATTRS'
*.wasm binary
*.traineddata binary
*.traineddata.gz binary
ATTRS
```

- [ ] **Step 7: Verify the files serve correctly**

With `python3 -m http.server 43869` running:

```bash
curl -sI http://localhost:43869/assets/tesseract/worker.min.js | head -3
curl -sI http://localhost:43869/assets/tesseract/lang/eng.traineddata.gz | head -3
```

Expected: `200 OK` for both.

- [ ] **Step 8: Commit**

```bash
git add assets/tesseract .gitattributes
git commit -m "chore: vendor tesseract.js 7.0.0 runtime for offline OCR"
```

---

### Task 7: Fast engine and the OCR lamp

**Files:**
- Modify: `index.html:767-778` — add the third lamp
- Modify: `index.html` — `lamps` map around line 1217
- Modify: `index.html` — new engine code near `ensureWhisper` (around line 1607)
- Modify: `index.html` — `state` object, add `tessLoading`, `tesseract`

**Interfaces:**
- Consumes: `state.image` (Task 5), the vendored paths (Task 6), `setLamp`, `setProgress`, `hideProgress` (existing)
- Produces: `ensureTesseract()` -> Tesseract worker; `extractText(canvas, engine)` -> `{ text, confidence, engine }`

- [ ] **Step 1: Add the lamp**

After the shaper lamp button in the rail:

```html
      <button class="lamp-btn" id="lamp-ocr" type="button" title="Load the text-extraction engine now, before you need it">
        <span class="led" id="led-ocr" data-state="idle"></span>
        OCR <span class="state" id="state-ocr">Loads on first use</span>
      </button>
```

Add to the `lamps` map:

```js
  ocr: { btn: $("lamp-ocr"), led: $("led-ocr"), state: $("state-ocr") },
```

- [ ] **Step 2: Import Tesseract from the vendored entry**

Beside the existing imports at the top of the module script. The vendored `tesseract.esm.min.js` is **default-export only** — a named import from it throws.

```js
import Tesseract from "./assets/tesseract/tesseract.esm.min.js";
const { createWorker } = Tesseract;
```

- [ ] **Step 3: Implement the loader**

Modelled on `ensureWhisper()` — same loading guard, same lamp transitions, same progress bar.

```js
/* Everything Tesseract needs is vendored under assets/, so this
   works with the network unplugged. Its language data still lands in
   IndexedDB on first run; the worker and core come off disk. */
const TESS_PATHS = {
  workerPath: new URL("./assets/tesseract/worker.min.js", location.href).href,
  corePath: new URL("./assets/tesseract/core/", location.href).href,
  langPath: new URL("./assets/tesseract/lang", location.href).href,
  gzip: true,
};

async function ensureTesseract() {
  if (state.tesseract) return state.tesseract;
  if (state.tessLoading) {
    while (state.tessLoading) await new Promise(r => setTimeout(r, 100));
    return state.tesseract;
  }
  state.tessLoading = true;
  lamps.ocr.btn.disabled = true;
  try {
    setLamp("ocr", "loading", "Starting Tesseract");
    setProgress(ocrProgress, 0);
    state.tesseract = await createWorker("eng", 1, {
      ...TESS_PATHS,
      logger: (m) => {
        if (typeof m.progress === "number") setProgress(ocrProgress, m.progress);
      },
    });
    setLamp("ocr", "ready", "Tesseract");
    console.log("[vox] tesseract ready", { corePath: TESS_PATHS.corePath });
    return state.tesseract;
  } catch (e) {
    setLamp("ocr", "off", "Failed to load");
    lamps.ocr.btn.disabled = false;
    console.error("[vox] tesseract load failed", { error: e.message });
    throw e;
  } finally {
    state.tessLoading = false;
    hideProgress(ocrProgress);
  }
}
```

Add `tesseract: null, tessLoading: false,` to `state`, and wire the lamp button beside the Whisper one:

```js
lamps.ocr.btn.addEventListener("click", () => { ensureTesseract().catch(() => {}); });
```

- [ ] **Step 4: Implement extractText with the fast path**

v6 made `text` the only default output, so the confidence data has to be asked for explicitly.

```js
/* One entry point, engine as an argument — the caller never branches
   on which engine is in use. Confidence comes back only from the fast
   engine; Florence-2 does not report one, hence the null. */
async function extractText(canvas, engine) {
  if (engine === "photo") return extractWithFlorence(canvas);

  const worker = await ensureTesseract();
  const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
  const words = (data.blocks || []).flatMap(b =>
    (b.paragraphs || []).flatMap(p => (p.lines || []).flatMap(l => l.words || [])));
  const confidence = words.length
    ? words.reduce((a, w) => a + (w.confidence ?? 0), 0) / words.length
    : (typeof data.confidence === "number" ? data.confidence : null);
  console.log("[vox] extracted with tesseract", {
    chars: (data.text || "").length, words: words.length,
    confidence: confidence == null ? null : Math.round(confidence),
  });
  return { text: (data.text || "").trim(), confidence, engine: "fast" };
}
```

- [ ] **Step 5: Add a temporary stub so the file parses**

Task 8 replaces this. Without it the module throws on load.

```js
async function extractWithFlorence() {
  throw new Error("Photo mode is not wired up yet");
}
```

- [ ] **Step 6: Verify the confidence shape at the console**

The exact output flags needed for per-word confidence in v7 are the one thing the spec marked as unverified. Load a screenshot, then in the console:

```js
const w = await ensureTesseract();
const r = await w.recognize(state.image.canvas, {}, { text: true, blocks: true });
console.log(Object.keys(r.data), r.data.confidence, r.data.blocks?.length);
```

Expected: `blocks` is a populated array, or `data.confidence` is a number. If **both** are absent, add `hocr: true` to the output flags and read confidences from there, then update `extractText` to match what the data actually offers. Do not leave the fallback chain resting on an assumption.

- [ ] **Step 7: Manual verification**

- Click the `OCR` lamp with the network **disabled** in devtools -> it goes `loading` then `ready — Tesseract`. This is the whole point of Task 6; if it fails offline, the vendored paths are wrong.
- In the console, `await extractText(state.image.canvas, "fast")` on a loaded code screenshot returns the text with a plausible confidence

- [ ] **Step 8: Commit**

```bash
git add index.html
git commit -m "feat: add Tesseract fast extraction engine and OCR lamp"
```

---

### Task 8: Photo engine — Florence-2 on WebGPU

**Files:**
- Modify: `index.html` — beside `ensureTesseract`, replacing the Task 7 stub
- Modify: `index.html` — `state`, add `florence`, `florenceLoading`

**Interfaces:**
- Consumes: `TF` (line 914), `GPU` (existing), `setLamp`, `setProgress`
- Produces: `ensureFlorence()`; `extractWithFlorence(canvas)` -> `{ text, confidence: null, engine: "photo" }`

- [ ] **Step 1: Pull the classes off the existing import**

`pipeline()` does not support Florence-2 in 3.0.2 or in any later version, so the Auto classes are used directly. Extend the existing destructure on line 917:

```js
const { pipeline, env, TextStreamer, InterruptableStoppingCriteria,
        AutoProcessor, AutoTokenizer, Florence2ForConditionalGeneration, RawImage } = TF;
```

- [ ] **Step 2: Implement the loader**

```js
const FLORENCE = "onnx-community/Florence-2-base-ft";

/* Florence-2 on WASM means a ~1.09GB fp32 download, which is not a
   real option, so Photo mode is WebGPU-only and says so rather than
   starting a download it cannot finish. fp16 is gated on the adapter
   actually advertising shader-f16. */
async function ensureFlorence() {
  if (state.florence) return state.florence;
  if (state.florenceLoading) {
    while (state.florenceLoading) await new Promise(r => setTimeout(r, 100));
    return state.florence;
  }
  if (!GPU.ok) throw new Error("Photo mode needs WebGPU. Use Fast, or open Vox in Chrome or Edge.");

  state.florenceLoading = true;
  lamps.ocr.btn.disabled = true;
  try {
    setLamp("ocr", "loading", "Downloading Florence-2");
    setProgress(ocrProgress, 0);

    let half = false;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      half = !!adapter?.features?.has("shader-f16");
    } catch { half = false; }

    /* embed_tokens at q4 is byte-identical to fp32 in this repo, so
       q4 there buys nothing — fp16 or fp32 only. */
    const dtype = half
      ? { embed_tokens: "fp16", vision_encoder: "fp16", encoder_model: "q4", decoder_model_merged: "q4" }
      : { embed_tokens: "fp32", vision_encoder: "fp32", encoder_model: "q4", decoder_model_merged: "q4" };

    const opts = {
      device: "webgpu",
      dtype,
      progress_callback: (p) => {
        if (p.status === "progress" && typeof p.progress === "number") setProgress(ocrProgress, p.progress / 100);
        else if (p.status === "ready") setProgress(ocrProgress, 1);
      },
    };

    const [processor, tokenizer, model] = await Promise.all([
      AutoProcessor.from_pretrained(FLORENCE),
      AutoTokenizer.from_pretrained(FLORENCE),
      Florence2ForConditionalGeneration.from_pretrained(FLORENCE, opts),
    ]);

    state.florence = { processor, tokenizer, model, half };
    setLamp("ocr", "ready", half ? "Florence-2 fp16" : "Florence-2 fp32");
    console.log("[vox] florence-2 ready", { half });
    return state.florence;
  } catch (e) {
    setLamp("ocr", "off", "Florence-2 failed");
    lamps.ocr.btn.disabled = false;
    console.error("[vox] florence-2 load failed", { error: e.message });
    throw e;
  } finally {
    state.florenceLoading = false;
    hideProgress(ocrProgress);
  }
}
```

Add `florence: null, florenceLoading: false,` to `state`.

- [ ] **Step 3: Replace the stub with the real run**

The `<OCR>` task prompt comes from the model repo's `preprocessor_config.json`, not from the library.

```js
async function extractWithFlorence(canvas) {
  const { processor, tokenizer, model } = await ensureFlorence();
  const task = "<OCR>";

  const image = await RawImage.fromCanvas(canvas);
  const vision = await processor(image);
  const prompts = processor.construct_prompts(task);
  const textInputs = tokenizer(prompts);

  const ids = await model.generate({
    ...textInputs, ...vision,
    max_new_tokens: 1024, num_beams: 1, do_sample: false,
  });
  const decoded = tokenizer.batch_decode(ids, { skip_special_tokens: false })[0];
  const out = processor.post_process_generation(decoded, task, image.size);
  const text = (out[task] || "").trim();

  console.log("[vox] extracted with florence-2", { chars: text.length });
  return { text, confidence: null, engine: "photo" };
}
```

- [ ] **Step 4: Disable Photo mode without WebGPU**

In the init section, beside the other `GPU.ok` checks:

```js
if (!GPU.ok) {
  const photo = $("ocr-engine").querySelector('option[value="photo"]');
  photo.disabled = true;
  photo.textContent = "Photo — needs WebGPU";
}
```

- [ ] **Step 5: Manual verification**

In Chrome or Edge, with a photo of a printed page loaded:
- Select `Photo`, click `Extract text` -> the lamp reads `Downloading Florence-2`, the progress bar advances, then `ready`
- The text comes back and is recognisably the page's text
- Reload and extract again -> no re-download (the models are in the Cache API), lamp goes straight to ready
- The `RawImage.fromCanvas` call is the one API here I have not verified against 3.0.2. If it is absent, use `await RawImage.fromURL(canvas.toDataURL("image/png"))` instead and note the swap in the commit message.
- In a browser without WebGPU (or with it disabled), the `Photo` option reads `needs WebGPU` and is unselectable

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: add Florence-2 photo extraction engine on WebGPU"
```

---

### Task 9: Extract action, output area and hand-off to the transcript

**Files:**
- Modify: `index.html` — event wiring near the other listeners
- Modify: `index.html` — `state`, add `extracting: false`

**Interfaces:**
- Consumes: `extractText` (Task 7/8), `state.image` (Task 5), `setCount`, `setNotice`, `backlight` (existing), `raw`, `btnShape`, `btnRegen` (existing)
- Produces: `runExtract()`; `state.lastExtract` = `{ text, confidence, engine }`

- [ ] **Step 1: Implement the extract action**

```js
/* Says which engine ran, how confident it was, and — when the answer
   is nothing — says that instead of blanking the box. An empty result
   is a result, and silently clearing the previous one would lose work. */
const OCR_LOW_CONFIDENCE = 60;

async function runExtract() {
  if (!state.image || state.extracting) return;
  state.extracting = true;
  btnExtract.disabled = true;
  setNotice(extractError, "");
  const engine = $("ocr-engine").value;
  extractState.textContent = engine === "photo" ? "Reading with Florence-2…" : "Reading with Tesseract…";
  setProgress(ocrProgress, null);

  const started = performance.now();
  try {
    const res = await extractText(state.image.canvas, engine);
    const ms = Math.round(performance.now() - started);

    if (!res.text) {
      extractState.textContent = `No text found (${engine}, ${ms}ms)`;
      setNotice(extractError, engine === "fast"
        ? "No text found. If this is a photo rather than a screenshot, try Photo mode."
        : "No text found in that image.");
      console.log("[vox] extraction empty", { engine, ms, how: state.image.how });
      return;
    }

    extracted.value = res.text;
    setCount(extractedCount, res.text);
    btnCopyText.disabled = false;
    btnToTranscript.disabled = false;
    state.lastExtract = res;

    const conf = res.confidence == null ? "" : ` · ${Math.round(res.confidence)}% confidence`;
    extractState.textContent = `${words(res.text)} words in ${ms}ms (${res.engine})${conf}`;
    if (res.confidence != null && res.confidence < OCR_LOW_CONFIDENCE) {
      setNotice(extractError,
        `Confidence is ${Math.round(res.confidence)}%, so this text is probably unreliable. Photo mode handles angled and low-contrast images better.`);
    }
    console.log("[vox] extraction done", {
      engine: res.engine, ms, chars: res.text.length,
      confidence: res.confidence == null ? null : Math.round(res.confidence),
      how: state.image.how,
    });
    touchSession();
    backlight(extracted);
  } catch (e) {
    extractState.textContent = "Extraction failed";
    setNotice(extractError, e.message);
    console.error("[vox] extraction failed", { engine, error: e.message });
  } finally {
    state.extracting = false;
    btnExtract.disabled = !state.image;
    hideProgress(ocrProgress);
  }
}

btnExtract.addEventListener("click", runExtract);
```

- [ ] **Step 2: Wire the two output actions**

```js
btnCopyText.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(extracted.value);
    extractState.textContent = "Copied";
  } catch {
    extracted.select();
    setNotice(extractError, "This browser blocked the clipboard. The text is selected — press ⌘C or Ctrl+C.");
  }
});

/* Appends exactly the way a second voice take appends, so everything
   downstream — shaping, templates, sessions — needs no idea that some
   of the transcript came out of a picture. */
btnToTranscript.addEventListener("click", () => {
  const text = extracted.value.trim();
  if (!text) return;
  raw.value = raw.value.trim() ? `${raw.value.trim()}\n\n${text}` : text;
  setCount(rawCount, raw.value);
  btnShape.disabled = false;
  btnRegen.disabled = false;
  store.set(KEY.draft, { raw: raw.value, refined: refined.value });
  touchSession();
  extractState.textContent = "Sent to transcript";
  backlight(raw);
  console.log("[vox] extraction sent to transcript", { chars: text.length });
});

extracted.addEventListener("input", () => {
  setCount(extractedCount, extracted.value);
  const empty = !extracted.value.trim();
  btnCopyText.disabled = empty;
  btnToTranscript.disabled = empty;
});
```

Add `extracting: false, lastExtract: null,` to `state`.

- [ ] **Step 3: Manual verification**

- Load a code screenshot, `Extract text` -> status reads `N words in Xms (fast) · 9x% confidence`, text appears
- `Copy text`, paste into a scratch editor -> matches
- `Send to transcript` -> the transcript box gains the text, `Shape prompt` enables, and `⌘↵` shapes it into a prompt as normal
- `Send to transcript` again -> appends below with a blank line, does not overwrite
- Load a blank white image, `Extract text` -> `No text found`, the previous text is **still there**
- Edit the extracted text by hand -> word count updates
- Load a deliberately blurry photo in Fast mode -> the low-confidence warning names a number and suggests Photo mode

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: wire extract action, copy and send-to-transcript"
```

---

### Task 10: Session persistence and thumbnail-aware eviction

**Files:**
- Modify: `index.html:1317-1327` (`persistSessions`)
- Modify: `index.html:1329-1344` (`touchSession`)
- Modify: `index.html:1346-1383` (`renderSessions`)
- Modify: `index.html:1385-1412` (`openSession`)
- Modify: `index.html:1311` (`snippet` callers)
- Modify: `index.html` — CSS, add `.session__thumb`
- Test: `index.html` (`?test=1`)

**Interfaces:**
- Consumes: `makeThumb` (Task 3), `state.image`, `state.lastExtract`
- Produces: session records with `extracted`, `thumb`, `ocrEngine`; `stripOldestThumbs(sessions, keep)` -> count stripped

- [ ] **Step 1: Write the failing tests for the eviction helper**

```js
test("stripOldestThumbs keeps the newest thumbnails", () => {
  const s = [{ thumb: "a" }, { thumb: "b" }, { thumb: "c" }, { thumb: "d" }];
  eq(stripOldestThumbs(s, 2), 2, "stripped count");
  eq(s.map(x => x.thumb || null), ["a", "b", null, null], "which survived");
});
test("stripOldestThumbs reports zero when there is nothing to strip", () => {
  const s = [{ thumb: "a" }, {}];
  eq(stripOldestThumbs(s, 5), 0, "stripped count");
  eq(s.map(x => x.thumb || null), ["a", null], "untouched");
});
test("stripOldestThumbs can strip everything", () => {
  const s = [{ thumb: "a" }, { thumb: "b" }];
  eq(stripOldestThumbs(s, 0), 2, "stripped count");
  eq(s.map(x => x.thumb || null), [null, null], "all gone");
});
```

- [ ] **Step 2: Run them to verify they fail**

Expected: 3 failures, `stripOldestThumbs is not defined`.

- [ ] **Step 3: Implement it and rework persistSessions**

```js
/* Sessions are newest-first, so the oldest thumbnails are at the tail.
   Returns how many were dropped, because the notice says so. */
function stripOldestThumbs(sessions, keep) {
  let n = 0;
  for (let i = keep; i < sessions.length; i++) {
    if (sessions[i].thumb) { delete sessions[i].thumb; n++; }
  }
  return n;
}
```

Replace `persistSessions` with:

```js
/* A long transcript, and now a thumbnail per extraction, can push the
   list past quota. Losing the newest session would be the worst
   outcome — and losing whole sessions to make room for pictures is
   nearly as bad, so thumbnails go first. Text outlives pictures. */
function persistSessions() {
  state.sessions = state.sessions.slice(0, SESSION_LIMIT);
  if (store.set(KEY.sessions, state.sessions)) return true;

  for (const keep of [12, 3, 0]) {
    const dropped = stripOldestThumbs(state.sessions, keep);
    if (!dropped) continue;
    if (store.set(KEY.sessions, state.sessions)) {
      console.warn("[vox] dropped session thumbnails to fit quota", { dropped, kept: keep });
      setNotice(storageWarn,
        `Browser storage was full, so Vox dropped ${dropped} old session thumbnail${dropped === 1 ? "" : "s"}. The text is untouched.`);
      return true;
    }
  }

  while (state.sessions.length > 3) {
    const before = state.sessions.length;
    state.sessions = state.sessions.slice(0, Math.max(3, Math.floor(state.sessions.length / 2)));
    if (store.set(KEY.sessions, state.sessions)) {
      console.warn("[vox] dropped oldest sessions to fit quota", { from: before, to: state.sessions.length });
      return true;
    }
  }
  return false;
}
```

Check the existing storage-notice element name first: `grep -n "storage-warn" index.html`. Use whatever constant the file already binds it to.

- [ ] **Step 4: Run the tests to verify they pass**

Expected: `16 passed, 0 failed`.

- [ ] **Step 5: Record the extraction on the session**

In `touchSession`, widen the early return and add the three fields:

```js
function touchSession() {
  if (!raw.value.trim() && !refined.value.trim() && !extracted.value.trim()) return;
```

then after `s.templateName = ...`:

```js
  s.extracted = extracted.value;
  s.ocrEngine = state.lastExtract?.engine || "";
  if (state.image && extracted.value.trim()) s.thumb = makeThumb(state.image.canvas);
```

- [ ] **Step 6: Show it in the rail**

In `renderSessions`, after `btn.className = ...`, add the thumbnail and widen the snippet fallback:

```js
    if (s.thumb) {
      const th = document.createElement("img");
      th.className = "session__thumb";
      th.src = s.thumb;
      th.alt = "";
      btn.appendChild(th);
    }
```

Change the meta line to name the engine, and the snippet to fall back to the extracted text:

```js
    meta.textContent = [sessionStamp(s.at), s.templateName, s.ocrEngine ? `ocr:${s.ocrEngine}` : "", `${n}w`]
      .filter(Boolean).join(" · ");

    snip.textContent = snippet(s.transcript) || snippet(s.extracted) || snippet(s.prompt) || "Empty";
```

Add the CSS beside the other `.session__*` rules:

```css
  .sessions .session__thumb {
    float: right; width: 34px; height: 34px; object-fit: cover;
    border-radius: 3px; margin: 0 0 2px 6px; opacity: .75;
  }
  .sessions .session:hover .session__thumb { opacity: 1; }
```

- [ ] **Step 7: Restore it in openSession**

After `refined.value = s.prompt || "";`:

```js
  extracted.value = s.extracted || "";
  setCount(extractedCount, extracted.value);
  btnCopyText.disabled = !extracted.value.trim();
  btnToTranscript.disabled = !extracted.value.trim();
```

The image itself is deliberately not restored — the spec stores a thumbnail, not the original — so also clear the working image so `Extract text` cannot run against a stale canvas:

```js
  clearImage();
```

- [ ] **Step 8: Manual verification**

- Extract text from a screenshot -> a session appears in the rail with a thumbnail and `ocr:fast` in its meta line
- Reload -> the session is still listed with its thumbnail
- Click it -> the extracted text comes back, the preview is empty, `Extract text` is disabled
- An image-only session (no voice take) shows its extracted text as the snippet, not `Empty`
- `New session` files it and clears the extracted box
- Delete it -> gone, and the workspace clears if it was open

- [ ] **Step 9: Verify the quota path deliberately**

In the console, fill storage until a write fails:

```js
try { localStorage.setItem("vox.ballast", "x".repeat(4_500_000)); } catch (e) { console.log("already tight", e.name); }
```

Then extract from another image. Expected: the notice reports dropped **thumbnails**, the session list keeps all its entries, and the newest session's text is intact. Then clean up:

```js
localStorage.removeItem("vox.ballast");
```

- [ ] **Step 10: Commit**

```bash
git add index.html
git commit -m "feat: store extractions in sessions with thumbnail-first eviction"
```

---

### Task 11: Documentation and test material

**Files:**
- Modify: `README.md`
- Modify: `samples.md`
- Create: `assets/ocr-sample-code.png`, `assets/ocr-sample-darkmode.png`, `assets/ocr-sample-angled.jpg`, `assets/ocr-sample-handwriting.jpg`
- Modify: `index.html` — the footer `#engine-note` paragraph and the keys list

**Interfaces:**
- Consumes: the finished feature
- Produces: nothing code depends on

- [ ] **Step 1: Capture the four reference images**

Make them yourself so they are representative, and keep each under ~400KB:

1. `ocr-sample-code.png` — a screenshot of 15-20 lines of code with punctuation-heavy syntax
2. `ocr-sample-darkmode.png` — a screenshot of light text on a dark background, deliberately low contrast
3. `ocr-sample-angled.jpg` — a phone photo of a printed page, shot at maybe 20 degrees off square
4. `ocr-sample-handwriting.jpg` — a photo of handwriting, the documented known-fail

```bash
ls -la assets/ocr-sample-*
```

- [ ] **Step 2: Add the extraction section to samples.md**

Match the existing pass/fail structure of the six dictation scripts. For each image state the engine, what a pass looks like, and what a fail looks like. Include verbatim:

```markdown
## Extraction samples

Four images, each aimed at one failure mode. Load each on the Image tab
and extract with the engine named.

### 1. Code screenshot — Fast

`assets/ocr-sample-code.png`

**Pass:** every line present, indentation roughly preserved, and
punctuation exact — `=>`, `{}`, `;` and quote characters are where the
screenshot has them. Confidence above 85%.

**Fail:** dropped lines, `l`/`1`/`I` or `O`/`0` swapped inside
identifiers, or smart quotes substituted for straight ones. Any of these
makes the text useless for pasting into an LM, which is the whole point.

### 2. Low-contrast dark-mode screenshot — Fast

`assets/ocr-sample-darkmode.png`

**Pass:** the text comes out complete. This is the case the upscale step
in `ocrTargetSize` exists for, so a pass here is partly a test of that.

**Fail:** empty result, or confidence under 60% — in which case the
warning must appear and name Photo mode. A silent bad result is a worse
failure than an honest empty one.

### 3. Angled photo of a printed page — Fast, then Photo

`assets/ocr-sample-angled.jpg`

**Pass:** Fast struggles visibly — garbled line ends, low confidence, or
both — and Photo returns readable prose. This is the sample that
justifies shipping two engines at all.

**Fail:** Photo does no better than Fast. If that happens the Florence-2
export ceiling documented in the spec is biting, and
`granite-docling-258M` is the next thing to try.

### 4. Handwriting — Fast, expected fail

`assets/ocr-sample-handwriting.jpg`

**Pass:** garbage or nothing, reported honestly. Tesseract does not
support handwriting at any setting, and this sample exists so that limit
stays visible rather than being rediscovered.

**Fail:** a confident-looking result that is wrong. Confidence must
reflect reality.
```

- [ ] **Step 3: Add a README section**

After the "How it works" section, matching the existing prose voice:

```markdown
## Pulling text out of an image

The `Source` module has two tabs. **Voice** is the microphone. **Image**
takes a picture and gives you its text, for the case where copying it by
hand is otherwise the only option — a screenshot of code, a forwarded chat
image, a photo of a printed page.

Four ways in: paste with `⌘V`, drop a file on the target, choose one, or
grab a region of your own screen. Whichever you use, the image is
normalized before extraction — capped at 2600px on the long edge, and
doubled if it is under 1000px, because resolution is most of OCR accuracy
and a small screenshot is the commonest failure.

Two engines, picked per image:

**Fast** is Tesseract, on the CPU, and it is the right choice for anything
rendered on a screen. Its whole runtime — worker, WASM core and English
language data — is vendored in `assets/tesseract/`, so it works with the
network unplugged, and it reports a confidence figure. Under 60% it says
so rather than handing you text it does not believe. It does not read
handwriting, and does not pretend to.

**Photo** is Florence-2 through WebGPU, for angled and real-world shots.
It is a ~357MB download on first use, so it is never selected for you.
Without WebGPU the option is disabled rather than offered and then failed.

The text lands in its own editable box — OCR mangles names and jargon the
same way Whisper does — with **Copy text**, and **Send to transcript**,
which appends it exactly as a second voice take appends. So a photo can be
shaped into a prompt by the same template chain, or just copied and taken
elsewhere.

Sessions keep the extracted text, which engine produced it, and a 256px
thumbnail so an old one is recognisable in the rail. The original image is
not kept; it would cost megabytes per session to buy only the ability to
re-run the other engine later. If storage does fill, thumbnails are
dropped before sessions are — text outlives pictures.

### A note on transformers.js

The Whisper and shaping models run on `@huggingface/transformers@3.0.2`,
and Photo mode deliberately runs on it too. Version 4 rewrote the WebGPU
execution provider and there is an open issue against exactly this app's
Whisper configuration — `device: "webgpu"` with an fp16 encoder — where
output collapses from 4.0.0 onward, with a 2.5GB fp32 encoder as the only
workaround. Florence-2 works on 3.0.2, so this feature does not force that
upgrade. If Photo mode ever needs replacing, `granite-docling-258M` needs
only a 3.x bump; the smaller `LightOnOCR-2-1B` would need v4 and is
therefore off the table while that issue is open.
```

- [ ] **Step 4: Update the tests section of the README**

Extend the existing `samples.md` sentence so the four images are mentioned alongside the six dictation scripts.

- [ ] **Step 5: Update the in-app footer**

The `#engine-note` paragraph currently promises models download once and then work offline. Extend it so the vendored Tesseract runtime is mentioned, and add a `⌘V paste an image` entry to the `.keys` list in the footer plate.

- [ ] **Step 6: Verify the docs match the build**

Re-read both files against the running app. Every path, size, engine name and key must be accurate — a README that lies is worse than one that is silent. Then:

Run: `python3 -m http.server 43869` and open `http://localhost:43869/?test=1`

Expected: `16 passed, 0 failed`.

- [ ] **Step 7: Commit**

```bash
git add README.md samples.md assets/ocr-sample-*.png assets/ocr-sample-*.jpg index.html
git commit -m "docs: document image text extraction and add reference samples"
```

---

## Final verification

- [ ] `http://localhost:43869/?test=1` reports `16 passed, 0 failed`
- [ ] With devtools set to offline and the Tesseract language data already cached, a full Fast extraction works end to end
- [ ] The voice path is untouched: record, transcribe, shape, copy, and check the transcript against a `samples.md` script
- [ ] `git log --oneline` shows one commit per task, no `WIP`
- [ ] `grep -n "transformers@3.0.2" index.html` still matches — the library was not bumped
- [ ] `du -sh assets/tesseract` is roughly 7MB
- [ ] All four `samples.md` extraction samples behave as documented, including the handwriting fail
