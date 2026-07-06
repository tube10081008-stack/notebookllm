// src/core/links.js — 노트 간 관계 제안 (지식 그래프의 엣지 생성)
// v1 문제 ①의 답: 이 모듈은 ingest 파이프라인에서 반드시 호출된다 (ingest.js 참조).
import { getLLM } from "../llm/index.js";
import { cosine } from "./similarity.js";

export const RELATION_TYPES = [
  "supports",      // 지지/보완
  "contradicts",   // 모순
  "applies_to",    // 적용
  "derived_from",  // 파생
  "obsoletes",     // 대체
  "related_to",    // 일반 관련
];

const LINKS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      target_id: { type: "string" },
      relation: { type: "string", enum: RELATION_TYPES },
    },
    required: ["target_id", "relation"],
  },
};

// newNote와 기존 벡터 저장소를 비교해 관계 엣지를 제안한다.
// 반환: [{ source, target, relation, proposed_at }]
export async function proposeLinks(newNote, newEmbedding, vectorStore) {
  const candidates = Object.entries(vectorStore.items || {})
    .filter(([id, item]) => id !== newNote.id && item.type !== "reference") // 참고 조각은 링크 대상 제외 (노이즈)
    .map(([id, item]) => ({ id, title: item.title || id, type: item.type || "fact", score: cosine(newEmbedding, item.v) }))
    .filter((c) => c.score > 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (candidates.length === 0) return [];

  const system = `당신은 지식 그래프 관계 분석 전문가입니다.
새 노트와 기존 노트 사이의 관계를 분석하세요.

관계 유형: supports(지지/보완) | contradicts(모순) | applies_to(적용) | derived_from(파생) | obsoletes(대체) | related_to(일반 관련)

JSON 배열로만 응답하세요: [{"target_id":"...","relation":"..."}]
관련성이 낮으면 빈 배열 []을 반환하세요.`;

  const prompt = `새 노트:
제목: ${newNote.title}
내용: ${(newNote.content || "").slice(0, 500)}
타입: ${newNote.type}

기존 노트 후보:
${candidates.map((c) => `- [${c.id}] "${c.title}" (${c.type}, 유사도: ${c.score.toFixed(2)})`).join("\n")}`;

  let proposed;
  try {
    proposed = await getLLM().chat({ system, prompt, json: true, schema: LINKS_SCHEMA });
    if (!Array.isArray(proposed)) proposed = proposed?.links || [];
  } catch (err) {
    console.warn("⚠️ 링크 제안 실패 (엣지 없이 진행):", err.message);
    return [];
  }

  const candidateIds = new Set(candidates.map((c) => c.id));
  return proposed
    .filter((l) => l?.target_id && candidateIds.has(l.target_id) && RELATION_TYPES.includes(l.relation))
    .map((l) => ({
      source: newNote.id,
      target: l.target_id,
      relation: l.relation,
      proposed_at: new Date().toISOString(),
      by: "llm",
    }));
}
