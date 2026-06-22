import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

function messagesOf(input) {
  return Array.isArray(input) ? input : [{ role: "user", content: String(input) }];
}

async function configOf(source) {
  const config = source.loadConfig ? await source.loadConfig() : source.config;
  if (!config || typeof config !== "object") throw new Error("missing LLM config");
  return config;
}

export function createLlmApi(source = {}) {
  async function query(input) {
    const { baseUrl, apiKey, apiKeyEnv, model } = await configOf(source);
    const key = apiKey || source.env?.[apiKeyEnv];
    if (!key) throw new Error(`missing LLM apiKey${apiKeyEnv ? ` or ${apiKeyEnv}` : ""}`);
    if (!baseUrl) throw new Error("missing LLM baseUrl");
    if (!model) throw new Error("missing LLM model");

    const provider = createOpenAICompatible({ name: "byok", apiKey: key, baseURL: baseUrl });
    const result = await generateText({
      model: provider(model),
      messages: messagesOf(input),
      temperature: 0,
      allowSystemInMessages: true,
      abortSignal: source.abortSignal
    });

    return {
      text: result.text.trim(),
      messages: result.response.messages,
      finishReason: result.finishReason
    };
  }

  return {
    query,
    llm: async (input) => (await query(input)).text
  };
}
