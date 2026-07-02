// src/core/distill.js — 콘텐츠 증류 (파싱된 원문 → 원자적 노트)
// v1 distiller.js 계승 + 구조화 출력(스키마)으로 정규식 JSON 세척 제거 (문제 ⑧)
import crypto from "crypto";
import { getLLM } from "../llm/index.js";
import { getAgentBehavior } from "./personas.js";

export const DEFAULT_HALF_LIFE = {
  fact: "permanent",
  concept: "permanent",
  procedure: "5yr",
  opinion: "6mo",
  temporal: "1yr",
};

// Gemini responseSchema (OpenAPI 서브셋). openai provider는 json_object 모드 + 프롬프트 명시로 동작.
const DISTILL_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      title: { type: "string" },
      content: { type: "string" },
      why_saved: { type: "string" },
      type: { type: "string", enum: ["fact", "concept", "procedure", "opinion", "temporal"] },
      topics: { type: "array", items: { type: "string" } },
      confidence: { type: "number" },
      conditions: { type: "array", items: { type: "string" } },
      implications: { type: "array", items: { type: "string" } },
    },
    required: ["title", "content", "type"],
  },
};

export async function distill(parsed, existingTopics = [], agent = null) {
  const { content, metadata } = parsed;

  if (!content || content.trim().length < 100) {
    return [makeNote({ title: metadata?.title, content: content || "" }, metadata)];
  }

  const behavior = agent ? getAgentBehavior(agent.personality) : null;
  const d = behavior?.distill || { maxNotes: 5, preferredTypes: ["fact", "concept"], minConfidence: 0.6, instruction: "" };

  const agentContext = agent
    ? `\n당신의 이름은 "${agent.name}"이고, ${agent.tone} 말투로 작성합니다.
전문 분야: ${agent.expertise}
content 필드를 작성할 때 당신의 전문성과 관점을 반영하세요.

[증류 전략]
${d.instruction}
- 선호 타입: ${d.preferredTypes.join(", ")}
- 최소 신뢰도: ${d.minConfidence} (이 기준 이하의 불확실한 정보는 제외)`
    : "";

  const system = `당신은 지식 관리 전문가입니다.${agentContext}
주어진 콘텐츠를 원자적 개념(Atomic Concept) 단위로 분해하세요.
각 개념은 하나의 독립적인 지식 단위여야 합니다.

기존 토픽 목록 (참고용): ${existingTopics.join(", ") || "없음"}

JSON 배열로만 응답하세요. 각 원소:
{"title":"간결한 제목(한국어, 기술 용어는 English)","content":"핵심 내용을 자신의 표현으로 재작성","why_saved":"왜 중요한지 한 줄","type":"fact|concept|procedure|opinion|temporal","topics":["토픽"],"confidence":0.8,"conditions":["유효 조건"],"implications":["함의"]}

규칙: 최소 1개~최대 ${d.maxNotes}개 / 노트당 하나의 핵심 아이디어 / confidence는 ${d.minConfidence}~1.0`;

  const prompt = `다음 콘텐츠를 원자적 개념으로 분해해주세요:

출처: ${metadata?.title || "알 수 없음"}
URL: ${metadata?.url || "없음"}

---
${content.slice(0, 15000)}
---`;

  let items;
  try {
    items = await getLLM().chat({ system, prompt, json: true, schema: DISTILL_SCHEMA });
    if (!Array.isArray(items)) items = items?.notes || null; // json_object 폴백 대응
  } catch (err) {
    console.warn("⚠️ LLM 증류 실패, 단일 노트로 폴백:", err.message);
    items = null;
  }

  if (!Array.isArray(items) || items.length === 0) {
    return [makeNote({ title: metadata?.title, content }, metadata)];
  }

  return items.slice(0, d.maxNotes).map((item) => makeNote(item, metadata));
}

function makeNote(item, metadata = {}) {
  const type = item.type || "fact";
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: item.title || (item.content || "").slice(0, 50) || "제목 없음",
    content: item.content || "",
    my_take: "",
    why_saved: item.why_saved || "직접 입력된 콘텐츠",
    type,
    topics: Array.isArray(item.topics) ? item.topics : [],
    half_life: DEFAULT_HALF_LIFE[type] || "permanent",
    confidence: Math.min(1, Math.max(0, item.confidence ?? 0.7)),
    conditions: item.conditions || [],
    implications: item.implications || [],
    source: {
      // 불변식 6: 출처 > 요약
      title: metadata?.title || "",
      url: metadata?.url || "",
      author: metadata?.author || "",
      date: metadata?.date || now,
      raw_ref: metadata?.raw_ref || "",
    },
    created_at: now,
    updated_at: now,
    last_accessed: now,
    access_count: 0,
    archived: false,
  };
}
