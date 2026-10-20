/* One transformers.js model per worker: Whisper, the CPU shaper, or
   Florence-2. Off the main thread, a multi-second session setup or a CPU
   generation no longer freezes the page, and separate workers let two
   models load at once.

   Protocol: the page posts { id, op, ...args } and gets { id, ok, value } or
   { id, ok: false, error } back. "progress" and "token" messages stream in
   between and carry no id. */
import * as TF from "../assets/transformers/transformers.min.js";

const { pipeline, env, TextStreamer, InterruptableStoppingCriteria,
        AutoProcessor, AutoTokenizer, Florence2ForConditionalGeneration, RawImage } = TF;
env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = new URL("../assets/transformers/", import.meta.url).href;

let model = null;     // a pipeline, or { processor, tokenizer, model } for Florence-2
let stopper = null;

const ops = {
  /* readMs runs until the last file arrives (from cache or network);
     initMs is the rest: session creation and, on WebGPU, shader setup. */
  async load({ kind, model: id, options }) {
    const started = performance.now();
    let lastFile = started;
    const progress_callback = (p) => {
      if (p.status === "done") lastFile = performance.now();
      postMessage({ op: "progress", p });
    };
    if (kind === "asr") {
      model = await pipeline("automatic-speech-recognition", id, { ...options, progress_callback });
    } else if (kind === "textgen") {
      model = await pipeline("text-generation", id, { ...options, progress_callback });
    } else if (kind === "florence") {
      const [processor, tokenizer, m] = await Promise.all([
        AutoProcessor.from_pretrained(id),
        AutoTokenizer.from_pretrained(id),
        Florence2ForConditionalGeneration.from_pretrained(id, { ...options, progress_callback }),
      ]);
      model = { processor, tokenizer, model: m };
    } else {
      throw new Error(`Unknown model kind: ${kind}`);
    }
    const done = performance.now();
    return { readMs: Math.round(lastFile - started), initMs: Math.round(done - lastFile) };
  },

  async transcribe({ audio, options }) {
    const out = await model(audio, options);
    return { text: out.text };
  },

  async generate({ messages, options }) {
    const streamer = new TextStreamer(model.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (text) => { if (text) postMessage({ op: "token", text }); },
    });
    stopper = InterruptableStoppingCriteria ? new InterruptableStoppingCriteria() : null;
    try {
      await model(messages, { ...options, streamer, ...(stopper ? { stopping_criteria: stopper } : {}) });
    } finally {
      stopper = null;
    }
  },

  // Handled between generation steps, which each await, so it lands mid-run.
  interrupt() { stopper?.interrupt?.(); },

  /* The <OCR> task prompt and its post-processing type come from the model
     repo's preprocessor_config.json, not from the library. */
  async ocr({ data, width, height }) {
    const { processor, tokenizer, model: m } = model;
    const task = "<OCR>";
    const image = new RawImage(data, width, height, 4);
    const vision = await processor(image);
    const textInputs = tokenizer(processor.construct_prompts(task));
    const ids = await m.generate({
      ...textInputs, ...vision,
      max_new_tokens: 1024, num_beams: 1, do_sample: false,
    });
    const decoded = tokenizer.batch_decode(ids, { skip_special_tokens: false })[0];
    const out = processor.post_process_generation(decoded, task, image.size);
    return (out[task] || "").trim();
  },
};

self.onmessage = async ({ data: { id, op, ...args } }) => {
  try {
    postMessage({ id, ok: true, value: await ops[op](args) });
  } catch (e) {
    postMessage({ id, ok: false, error: e?.message || String(e) });
  }
};
