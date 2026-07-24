// src/llm/usage.js — 토큰 사용량 계측 (M1: 측정 없이는 최적화도 없다)
//
// provider들이 호출 후 recordUsage()로 적재하고, 서버 라우트가 연산 단위로
// snapshot() diff를 떠서 이벤트(usage)로 남긴다. Gemini는 usageMetadata 실측,
// 임베딩·mock은 문자수/4 추정(approx). 프로세스 수명 동안의 누적 카운터.
const counters = {
  promptTokens: 0,      // LLM 입력 (실측 우선)
  outputTokens: 0,      // LLM 출력
  embedTokens: 0,       // 임베딩 (추정)
  llmCalls: 0,
  embedCalls: 0,
  approx: false,        // 추정치가 섞였는지
};

export function recordUsage({ promptTokens = 0, outputTokens = 0, embedTokens = 0, llmCall = false, embedCall = false, approx = false }) {
  counters.promptTokens += promptTokens;
  counters.outputTokens += outputTokens;
  counters.embedTokens += embedTokens;
  if (llmCall) counters.llmCalls += 1;
  if (embedCall) counters.embedCalls += 1;
  if (approx) counters.approx = true;
}

export function estimateTokens(text) {
  // 보수적 추정: 한국어 혼합 텍스트 ≈ 2자/토큰, 영문 ≈ 4자/토큰 → 3자/토큰 절충
  return Math.ceil(String(text || "").length / 3);
}

export function snapshot() {
  return { ...counters };
}

// 연산(라우트) 단위 사용량: 시작 스냅샷과의 차이
export function diffSince(start) {
  return {
    promptTokens: counters.promptTokens - start.promptTokens,
    outputTokens: counters.outputTokens - start.outputTokens,
    embedTokens: counters.embedTokens - start.embedTokens,
    llmCalls: counters.llmCalls - start.llmCalls,
    embedCalls: counters.embedCalls - start.embedCalls,
  };
}
