import type { LanguageModel } from "ai";
import type { LlmProfile } from "../config/index.ts";

const ENV_API_KEYS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

export async function getApiKeyForProfile(profile: LlmProfile): Promise<string | undefined> {
  return profile.apiKey?.trim() || process.env[ENV_API_KEYS[profile.provider] || ""];
}

export function getModel(profile: LlmProfile): LanguageModel {
  const { provider, model: modelId, apiKey, baseUrl } = profile;

  switch (provider) {
    case "anthropic": {
      const { createAnthropic } = require("@ai-sdk/anthropic");
      return createAnthropic({ apiKey: apiKey || process.env.ANTHROPIC_API_KEY })(modelId);
    }
    case "openai": {
      if (baseUrl) {
        const { createOpenAICompatible } = require("@ai-sdk/openai-compatible");
        return createOpenAICompatible({ baseURL: baseUrl, apiKey: apiKey || process.env.OPENAI_API_KEY })(modelId);
      }
      const { createOpenAI } = require("@ai-sdk/openai");
      return createOpenAI({ apiKey: apiKey || process.env.OPENAI_API_KEY })(modelId);
    }
    case "google": {
      const { createGoogleGenerativeAI } = require("@ai-sdk/google");
      return createGoogleGenerativeAI({ apiKey: apiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY })(modelId);
    }
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}
