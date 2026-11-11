import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

/** The Gemini model, or null when no API key is configured (everything then has a non-LLM fallback). */
export function getModel(): LanguageModel | null {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) return null;
  const google = createGoogleGenerativeAI({ apiKey });
  return google(process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL);
}

export function llmAvailable(): boolean {
  return Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
}

export function modelName(): string | null {
  return llmAvailable() ? process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL : null;
}
