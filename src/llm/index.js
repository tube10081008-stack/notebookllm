// src/llm/index.js — LLM Provider 추상화 (불변식 4: 모든 LLM 호출의 유일한 창구)
//
// 인터페이스:
//   chat({ system, prompt, json, schema })  → string | parsed JSON
//   embed(texts: string[])                  → { model, dims, vectors: number[][] }
//   embedOne(text)                          → number[]
//   describeMedia({ mimeType, dataBase64, instruction }) → string  (OCR/이미지/PDF)
//   info()                                  → { provider, textModel, embedModel, dims }
//
// provider 교체는 .env의 LLM_PROVIDER 변경으로 끝난다.
// 임베딩 모델 교체 시에는 반드시 `npm run reindex`로 벡터를 재구축한다 (불변식 2).
import { config } from "../config.js";
import { createGeminiProvider } from "./gemini.js";
import { createOpenAIProvider } from "./openai.js";
import { createMockProvider } from "./mock.js";

// ── 공통: 스로틀 + 지수 백오프 재시도 (v1 gemini.js에서 계승) ──
const MIN_INTERVAL_MS = 100;
let lastCallTime = 0;

async function throttle() {
  const elapsed = Date.now() - lastCallTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - elapsed));
  }
  lastCallTime = Date.now();
}

export async function withRetry(fn, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await throttle();
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const status = err?.status ?? 0;
      const retryable = status === 429 || status >= 500 || !status;
      if (!retryable) throw err;
      const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      console.warn(`⚠️ LLM 호출 실패 (${attempt}/${maxAttempts}), ${(delay / 1000).toFixed(1)}초 후 재시도: ${err.message}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ── 구조화 출력 파싱 (⑧ 정규식 세척 3중복 → 단일 지점) ──
// provider가 responseSchema/response_format을 지원하면 이 함수는 보험일 뿐이다.
export function parseModelJSON(raw) {
  const cleaned = String(raw)
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  return JSON.parse(cleaned);
}

// ── Provider 팩토리 ──
let instance = null;

export function createLLM(cfg = config) {
  switch (cfg.provider) {
    case "gemini": return createGeminiProvider(cfg, { withRetry, parseModelJSON });
    case "openai": return createOpenAIProvider(cfg, { withRetry, parseModelJSON });
    case "mock":   return createMockProvider(cfg);
    default:
      throw new Error(`알 수 없는 LLM_PROVIDER: "${cfg.provider}" (gemini|openai|mock)`);
  }
}

export function getLLM() {
  if (!instance) instance = createLLM();
  return instance;
}
