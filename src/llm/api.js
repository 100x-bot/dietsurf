import { generateText, jsonSchema, tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

function messagesOf(input) {
  return Array.isArray(input) ? input : [{ role: "user", content: String(input) }];
}

function bashTool() {
  return tool({
    description: "Run one command in the DietSurf bash-like shell.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute."
        }
      },
      required: ["command"],
      additionalProperties: false
    })
  });
}

export function createLlmApi(runtime) {
  async function query(input, options = {}) {
    runtime.throwIfAborted();
    const { baseUrl, apiKey, apiKeyEnv, model } = JSON.parse(await runtime.readFile(runtime.llmConfigPath));
    const key = apiKey || runtime.env[apiKeyEnv];
    if (!key) throw new Error(`missing ${runtime.llmConfigPath} apiKey${apiKeyEnv ? ` or ${apiKeyEnv}` : ""}`);

    const provider = createOpenAICompatible({ name: "byok", apiKey: key, baseURL: baseUrl });
    const request = {
      model: provider(model),
      messages: messagesOf(input),
      temperature: 0,
      allowSystemInMessages: true,
      abortSignal: runtime.abortSignal
    };

    if (options.tool === "bash") request.tools = { bash: bashTool() };

    const result = await generateText(request);
    runtime.throwIfAborted();
    return {
      text: result.text.trim(),
      toolCalls: result.toolCalls,
      messages: result.response.messages,
      finishReason: result.finishReason
    };
  }

  return {
    query,
    llm: async (input) => (await query(input)).text
  };
}
