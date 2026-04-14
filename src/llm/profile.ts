import type { LlmProfile, AppConfig } from "../config/index.ts";

const ENV_API_KEYS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

export async function getApiKeyForProfile(profile: LlmProfile): Promise<string | undefined> {
  return profile.apiKey?.trim() || process.env[ENV_API_KEYS[profile.provider] || ""];
}

export async function runOAuthLoginCommand(_config: AppConfig, _requestedProvider?: string): Promise<void> {
  throw new Error("OAuth login not yet implemented - use API key authentication instead");
}
