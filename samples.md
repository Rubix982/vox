# Test samples — "Coding task"

Read these aloud with the filler intact; the disfluency is part of what's being tested. Or paste them into the transcript box directly — shaping works on typed text too.

Each sample targets one failure mode. The **Pass** line is what to check; the **Fail** line is what a weak model does instead.

---

## 1 · Detail preservation

> Okay so, um, I need to add rate limiting to the API. The routes live in `server/routes/` and we're using Express with, uh, the `express-rate-limit` package — it's already in `package.json`. I want it on the login and signup endpoints only, like fifteen requests per minute per IP, and it should return a 429 with a JSON body, not HTML. Um, and don't touch the existing middleware order, because that broke things last time.

**Pass** — every specific survives: `server/routes/`, Express, `express-rate-limit`, login and signup only, 15/min/IP, 429 with JSON, middleware order untouched. `Tried already` is `(not specified)`.

**Fail** — "the API routes" instead of the path, the rate limit dropped or rounded, or Redis appearing in Context because rate limiting usually involves Redis. You didn't say Redis.

---

## 2 · Refusing to invent

> So the dashboard is slow. Like, really slow. I think it's the chart component but I'm not sure. Can you, um, make it faster? It's React and there's a bunch of data. Yeah.

This is the important one. There is almost nothing here, and the correct output is mostly empty with a substantial `Concerns` section.

**Pass** — `Constraints: (not specified)`, `Tried already: (not specified)`, and Concerns asks real questions: which route, how much data, is it render time or fetch time, what counts as fast enough.

**Fail** — Context gains a tech stack you never described, or Concerns turns into a fix list (`React.memo`, virtualization, pagination). Suggestions are invention here; you asked for none.

---

## 3 · Self-correction mid-sentence

> Alright, I want to add dark mode. Um, so there's a theme context in `src/context/Theme.tsx` — no wait, it's `src/contexts/theme.tsx`, lowercase. It reads from localStorage right now. I want it to respect `prefers-color-scheme` by default, and only use localStorage when the user has explicitly picked something. Uh, the tokens are in `styles/tokens.css`. Don't add a dependency for this, we're trying to keep the bundle small. And it needs to not flash white on first paint — that's the annoying part.

**Pass** — the corrected path only: `src/contexts/theme.tsx`, lowercase. Both the no-dependency constraint and the no-flash requirement appear.

**Fail** — the abandoned path `src/context/Theme.tsx` shows up, or both are listed as if they're two files.

---

## 4 · "Tried already"

> I'm trying to get file upload working with presigned S3 URLs. Um, I already tried using the AWS SDK v3 client directly in the browser and it blew up on CORS, and then I tried proxying through our Next API route in `app/api/upload/route.ts`, but that hit the four-and-a-half-megabyte body limit. Files can be up to like two hundred megs. I'm on Next 14 with the app router.

**Pass** — both attempts land in `Tried already` with their specific failures (CORS; 4.5 MB body limit). 200 MB is a constraint. Next 14 app router is context.

**Fail** — the attempts get folded into Context, losing the fact that they already failed, or the bucket name / region / auth method gets invented.

---

## 5 · Jargon Whisper will mangle

> Okay so, um, I want to swap our auth over to OAuth with PKCE. Right now we're using NextAuth with the credentials provider, and the session callback is in `lib/auth.ts`. Uh, we also use Zod for validating the callback params, and tRPC for the API layer — so the context builder in `server/trpc/context.ts` needs the new session shape. Keep the pnpm workspace layout as it is.

Expect Whisper to produce "P-K-C-E", "Sod" or "Zaad", "T-RPC", "P-N-P-M". **Fix them in the transcript box, then shape.** That's the whole reason the transcript is editable — the corrections propagate into the prompt.

**Pass** — the shaped prompt contains your corrected spellings, not Whisper's guesses.

---

## 6 · The escape hatch

> Hey, hope you're doing well. I just wanted to test out this voice thing and see how it handles a bit of rambling. Nothing really to do here. Thanks, bye.

**Pass** — one line: `NOT A TASK — ` followed by a one-sentence summary of what you said.

**Fail** — a fully populated prompt about testing a voice feature. That's the template filling its own skeleton, which is what samples 2 and 6 exist to catch.

---

## Reference output

Sample 1, shaped correctly:

```markdown
## Goal
Add rate limiting to the login and signup API endpoints.

## Context
Express API with routes in `server/routes/`. The `express-rate-limit` package is
already a dependency in `package.json`.

## Constraints
- Apply to the login and signup endpoints only.
- 15 requests per minute per IP.
- Return 429 with a JSON body, not HTML.
- Do not change the existing middleware order; changing it has caused breakage before.

## Tried already
(not specified)

## Concerns
- Where should the counter live? In-process memory won't hold across multiple
  instances, and the transcript doesn't say whether the API runs as more than one.
- What shape should the 429 JSON body take? No existing error format was described.
- Should the limit apply per endpoint or across both combined?
```

Note the voice: it addresses the assistant directly. If you get "The speaker wants to add rate limiting…", the model is narrating rather than writing a prompt — check the model size before editing the template.

Note what is *not* there: no Redis, no middleware filenames, no test framework. If your output has those, the model is filling gaps rather than reading you.

## If results are poor

Check the model in the dropdown first. Llama 3.2 3B follows these rules meaningfully better than Qwen2.5 1.5B, and the 0.5B CPU fallback will struggle with anything structured — use **Plain cleanup** with that one.

---

# Extraction samples

Reference images for the Image tab, each aimed at one failure mode. Load one,
extract with the engine named, and compare against what is written here. The
figures below are what this build actually produced, not targets.

## 1. Code screenshot — Fast

`assets/ocr-sample-code.png` — a genuine screenshot of syntax-coloured code on
a light ground, 760×400.

**Measured:** 85 words, 80% confidence, 638ms.

**Pass:** every line present, indentation roughly preserved, and the
punctuation-heavy parts intact — `=>`, `{}`, `;`, quotes where the screenshot
has them.

**Fail:** dropped lines, or smart quotes substituted for straight ones. Either
makes the text useless for pasting into an LM, which is the whole point.

**Known imperfections in this build:** the gutter line numbers get misread
(`2` → `©`, and similar), and the template literal `` `used at ${w}x${h}` ``
comes back mangled. Both are cosmetic against the body of the code. If you
want a stricter sample, crop the gutter out.

## 2. Low-contrast dark-mode screenshot — Fast

`assets/ocr-sample-darkmode.png` — a genuine screenshot of Vox's own footer,
900×560: dim text on a dark ground, with a large bright panel above it.

**Measured:** 98 words, 83% confidence, 1144ms.

**Pass:** the footer prose comes out readable. The keycap row (`Space record /
stop`) will be rough — small text in boxes — and that is acceptable.

**Fail:** *an empty result.* This sample exists because of a specific bug: with
Tesseract's default global Otsu threshold, this image returned **zero
characters**, silently. One threshold computed across an image holding both a
bright panel and a dark one suits neither. The engine is now configured with
`thresholding_method: "1"` (LeptonicaOtsu, which thresholds in tiles), and that
is what took this sample from 0 characters to 561. If this sample ever comes
back empty again, that setting is the first thing to check.

Worth knowing: text polarity is *not* the problem here, and inverting the image
changes nothing — measured identical output both ways. Do not add an inversion
step on the theory that it will help.

## 3. Angled page — Fast, then Photo

`assets/ocr-sample-angled.png` — the code screenshot rendered in CSS 3D at
roughly 22° with uneven lighting across the sheet, 900×600.

**This is a synthetic proxy, not a photograph.** The perspective and the
lighting gradient are real, but a phone camera also brings sensor noise, focus
falloff and JPEG artefacts that this image does not have. Replace it with a
real photo when you have one; the entry below still describes what to look for.

**Measured with Fast:** 146 words, **35% confidence**, and the output is
largely noise (`BE CE BE Ee - Te. 3 Bh`). The low-confidence warning fires and
points at Photo mode — which is the designed behaviour, not a failure.

**Measured with Photo:** 66 words in 4.3s (model already cached), and it
recovers the actual content — "Resolution is most of OCR accuracy",
`upscaled 2x`, `downscaled` — where Fast recovered none of it.

**Pass:** Fast struggles visibly *and says so*, and Photo returns recognisable
content. This is the sample that justifies shipping two engines at all.

**Fail:** Photo does no better than Fast. If that happens, the Florence-2
export ceiling documented in the design doc is biting, and
`granite-docling-258M` is the next thing to try.

Note Photo's output is still imperfect — it invents plausible-looking code
(`OCRTargesize`, `2606` for `2600`). Photo mode is for reading prose off a
photographed page, not for recovering code verbatim.

## 4. Handwriting — Fast, expected fail

**No image is committed for this case.** Tesseract's own FAQ states that
handwriting is unsupported at any setting, so the sample exists to keep that
limit visible — but a rendered handwriting *font* would not test it honestly.
A font is regular enough that Tesseract may well read it, which would make the
sample assert a limit it never exercised.

To fill this slot, photograph a few lines of real handwriting and save it as
`assets/ocr-sample-handwriting.jpg`.

**Pass:** garbage or nothing, with a confidence figure low enough to warn.

**Fail:** a confident-looking result that is wrong. Confidence has to reflect
reality — that is the whole basis for trusting the number.
