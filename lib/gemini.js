// lib/gemini.js — Gemini API 래퍼 (생성 + 임베딩)
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

// ── 초기화 ──────────────────────────────────────────
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const TEXT_MODEL = "gemini-3.5-flash";
const EMBED_MODEL = "gemini-embedding-2";
const EMBED_DIMS = 768;

// ── Rate-limiting 큐 ─────────────────────────────────
let lastCallTime = 0;
const MIN_INTERVAL_MS = 100; // 호출 간 최소 100ms 간격

async function throttle() {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - elapsed));
  }
  lastCallTime = Date.now();
}

// ── Retry 로직 (exponential backoff) ────────────────
async function withRetry(fn, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await throttle();
      return await fn();
    } catch (err) {
      const isLast = attempt === maxAttempts;
      if (isLast) throw err;

      // 429(rate limit) 또는 5xx(서버 오류)일 때만 재시도
      const status = err?.status ?? err?.httpStatusCode ?? 0;
      const retryable = status === 429 || status >= 500 || !status;
      if (!retryable) throw err;

      const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      console.warn(
        `⚠️ Gemini 호출 실패 (시도 ${attempt}/${maxAttempts}), ` +
          `${(delay / 1000).toFixed(1)}초 후 재시도...`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ── 텍스트 생성 ──────────────────────────────────────
export async function generateText(prompt, systemInstruction) {
  return withRetry(async () => {
    const config = {};
    if (systemInstruction) {
      config.systemInstruction = systemInstruction;
    }

    const response = await ai.models.generateContent({
      model: TEXT_MODEL,
      contents: prompt,
      config,
    });
    return response.text;
  });
}

// ── 단일 텍스트 임베딩 ────────────────────────────────
export async function embedText(text) {
  return withRetry(async () => {
    const response = await ai.models.embedContent({
      model: EMBED_MODEL,
      contents: text,
      config: { outputDimensionality: EMBED_DIMS },
    });
    return response.embeddings[0].values;
  });
}

// ── 배치 임베딩 (개별 호출 병렬 처리) ─────────────────
export async function embedBatch(texts) {
  if (!texts.length) return [];

  // 동시 호출 수 제한 (rate limit 고려)
  const CONCURRENCY = 3;
  const allEmbeddings = [];

  for (let i = 0; i < texts.length; i += CONCURRENCY) {
    const chunk = texts.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map((text) => embedText(text)),
    );
    allEmbeddings.push(...results);
  }

  return allEmbeddings;
}

export { ai, TEXT_MODEL, EMBED_MODEL, EMBED_DIMS };
