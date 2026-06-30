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
    const config = await configOf(source);
    const { baseUrl, apiKey, apiKeyEnv, model } = config;
    const key = apiKey || source.env?.[apiKeyEnv];
    if (!key) {
      await source.onMissingKey?.(config);
      throw new Error("missing LLM apiKey");
    }
    if (!baseUrl) throw new Error("missing LLM baseUrl");
    if (!model) throw new Error("missing LLM model");

    const provider = createOpenAICompatible({ name: "byok", apiKey: key, baseURL: baseUrl });
    const result = await generateText({
      model: provider(model),
      messages: messagesOf(input),
      temperature: Number.isFinite(config.temperature) ? config.temperature : 0,
      topP: Number.isFinite(config.topP) ? config.topP : undefined,
      maxOutputTokens: Number.isFinite(config.maxOutputTokens) ? config.maxOutputTokens : undefined,
      presencePenalty: Number.isFinite(config.presencePenalty) ? config.presencePenalty : undefined,
      frequencyPenalty: Number.isFinite(config.frequencyPenalty) ? config.frequencyPenalty : undefined,
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
