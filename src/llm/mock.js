// src/llm/mock.js — 결정적 더미 provider
// 용도: ① API 키 없이 전체 파이프라인 동작 확인 ② 자동 테스트 ③ 오프라인 데모
// 임베딩은 텍스트 해시 기반의 결정적 의사난수 단위벡터 — 같은 텍스트는 항상 같은 벡터.
// (품질 평가용이 아니다. claudeWIKI 실측 교훈: 더미 임베딩은 검색을 망친다 — 어디까지나 배관 검증용)

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createMockProvider(cfg) {
  const dims = cfg.embedDims;

  function embedVector(text) {
    // 단어 단위 해시 벡터의 합 → 유사 단어를 공유하는 텍스트는 유사한 벡터 (배관 검증에 충분)
    const acc = new Array(dims).fill(0);
    const words = String(text).toLowerCase().split(/\s+/).filter(Boolean);
    for (const w of words) {
      const rand = mulberry32(hashSeed(w));
      for (let i = 0; i < dims; i++) acc[i] += rand() - 0.5;
    }
    const norm = Math.sqrt(acc.reduce((s, x) => s + x * x, 0)) || 1;
    return acc.map((x) => x / norm);
  }

  return {
    info: () => ({ provider: "mock", textModel: "mock", embedModel: `mock-${dims}d`, dims }),

    async chat({ prompt, json = false, schema = null }) {
      if (!json) return `[mock] ${String(prompt).slice(0, 120)}...`;
      // 스키마 형태를 보고 최소 유효 응답 생성
      if (schema?.properties?.mode) {
        // 콘텐츠 분류 태스크 (애매 구간) — 샘플의 문장부호 유무로 간단 판단
        const t = String(prompt);
        const hasPunct = (t.match(/[.!?。]/g) || []).length > 3;
        return { mode: hasPunct ? "concept" : "reference", why: "[mock] 문장부호 기반 판단" };
      }
      if (schema?.properties?.personality) {
        // 에이전트 합성 태스크
        return {
          name: "모키", avatar: "🤖", tone: "간결하고 실용적인",
          expertise: "mock 도메인 전문", greeting: "mock 에이전트입니다!",
          personality: "practical",
          system_prompt: "당신은 mock 합성 에이전트 '모키'입니다. 간결하게 답변합니다.",
        };
      }
      if (schema?.items?.properties?.target_id) {
        // 링크 제안 태스크: 후보 목록의 첫 ID로 related_to 관계 반환
        const m = String(prompt).match(/- \[([0-9a-f-]{36})\]/);
        return m ? [{ target_id: m[1], relation: "related_to" }] : [];
      }
      if (schema?.type === "array") {
        return [{
          title: String(prompt).replace(/\s+/g, " ").slice(0, 40) || "mock note",
          content: String(prompt).slice(0, 400),
          why_saved: "mock 증류 결과",
          type: "fact",
          topics: ["mock"],
          confidence: 0.7,
          conditions: [],
          implications: [],
        }];
      }
      return { answer: "[mock] 참고 노트를 기반으로 한 모의 답변입니다.", confidence: "low", gaps: ["측정 방법"] };
    },

    async embed(texts) {
      return { model: `mock-${dims}d`, dims, vectors: texts.map(embedVector) };
    },

    async embedOne(text) {
      return embedVector(text);
    },

    async describeMedia({ instruction }) {
      return `[mock media 분석] ${instruction.slice(0, 80)}`;
    },

    async transcribeVideo({ url }) {
      return `[mock 영상 분석] ${url} — 이 영상은 미분과 적분의 관계를 시각적으로 설명한다. 누적 넓이의 순간 변화율이 원래 함수와 같다는 직관을 다룬다.`;
    },
  };
}
