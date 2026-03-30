import type { LlmProfile } from "../config/index.ts";

const ENV_API_KEYS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

export async function getApiKeyForProfile(profile: LlmProfile): Promise<string | undefined> {
  return profile.apiKey?.trim() || process.env[ENV_API_KEYS[profile.provider] || ""];
}
