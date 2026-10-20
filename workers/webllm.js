/* WebLLM's own worker protocol: the page drives this through
   CreateWebWorkerMLCEngine, with the same API as an in-page engine. */
import { WebWorkerMLCEngineHandler } from "../assets/web-llm/web-llm.js";

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
