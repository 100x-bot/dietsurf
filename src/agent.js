const SYSTEM_PROMPT = [
  "You are DietSurf, a small browser agent running in a Chrome extension service worker.",
  "To inspect or act, reply with one fenced JavaScript block using the service-worker context.",
  "The JavaScript block runs with service-worker globals such as chrome, llm, fetch, console, crypto, caches, indexedDB, URL, TextEncoder, TextDecoder, setTimeout, and clearTimeout.",
  "There is no shell, bash, Linux command layer, filesystem shim, Git helper, Node runtime, require, process, Buffer, runtime object, or done function.",
  "When you need the browser, use Chrome extension APIs directly, for example chrome.tabs.query and chrome.scripting.executeScript.",
  "When you are finished, answer normally without a fenced JavaScript block. A response without a JavaScript block is the only stop signal."
].join("\n");

const JS_BLOCK_RE = /```(?:js|javascript)\s*([\s\S]*?)```/i;

export function extractJavaScriptBlock(text) {
  const match = JS_BLOCK_RE.exec(String(text || ""));
  return match ? match[1].trim() : "";
}

function assistantText(response) {
  return String(response?.text || "").trim();
}

function observationText(observation) {
  return JSON.stringify(observation, null, 2);
}

function appendAssistant(messages, text) {
  messages.push({ role: "assistant", content: text || "" });
}

function appendObservation(messages, observation) {
  messages.push({
    role: "user",
    content: "Observation:\n" + observationText(observation)
  });
}

export async function runAgent({
  goal,
  query,
  execute,
  log = () => undefined,
  checkAbort = () => undefined,
  maxSteps = 20
}) {
  const cleanGoal = String(goal || "").trim();
  if (!cleanGoal) return "";

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: cleanGoal }
  ];

  for (let step = 0; step < maxSteps; step++) {
    checkAbort();
    const response = await query(messages);
    checkAbort();

    const text = assistantText(response);
    appendAssistant(messages, text);

    const code = extractJavaScriptBlock(text);
    if (!code) return text;

    log(text);
    let observation;
    try {
      observation = await execute(code);
    } catch (error) {
      observation = {
        ok: false,
        error: error && error.message ? error.message : String(error)
      };
    }
    log("Observation:");
    log(observationText(observation));
    appendObservation(messages, observation);
  }

  return "";
}
