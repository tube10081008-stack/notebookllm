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

// ── 자동 분류: 개념(산문) vs 참고자료(목록·표) ────────
// 사용자에게 유형 판별을 떠넘기지 않는다 — 구조를 보고 시스템이 판단한다.
// 결정적·설명가능한 휴리스틱: 짧은 항목 줄이 많고 완결 문장이 적으면 목록,
// 문장으로 이어진 산문이면 개념. (애매하면 안전하게 개념)
export function classifyContent(parsed) {
  const text = (parsed?.content || "").trim();
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 6) return { mode: "concept", reason: "짧은 콘텐츠 — 개념으로 처리" };

  const n = lines.length;
  const shortRatio = lines.filter((l) => l.length <= 45).length / n;
  const sentenceRatio = lines.filter((l) => /[.。!?…”"]\s*$/.test(l)).length / n;
  const delimRatio = lines.filter((l) => l.length <= 80 && /\t|\s{2,}|[|:：,，]/.test(l)).length / n;

  if (sentenceRatio < 0.35 && (shortRatio >= 0.6 || delimRatio >= 0.55)) {
    return {
      mode: "reference",
      reason: `목록·표 감지 (짧은 항목 ${Math.round(shortRatio * 100)}%, 완결 문장 ${Math.round(sentenceRatio * 100)}%)`,
    };
  }
  return { mode: "concept", reason: "산문형 — 개념으로 처리" };
}

// ── 참고 자료 모드 (목록·표·용어집) ──────────────────
// 증류(개념 압축)는 데이터를 파괴한다: 300개 단어 리스트 → "300개짜리 리스트"라는 요약 한 장.
// 참고 자료는 원문을 손실 없이 "검색 가능한 조각"으로 보존한다 (고전 RAG 청킹).
// 각 조각은 실제 항목(단어·병음·뜻)을 그대로 담아, 질의 시 그 내용이 컨텍스트로 들어간다.
export function chunkReference(parsed, { maxChars = 900, maxChunks = 60 } = {}) {
  const { content, metadata } = parsed;
  const text = (content || "").trim();
  if (!text) return [];

  // 줄 단위로 모으되 maxChars를 넘지 않게 (표·리스트의 행 경계를 존중)
  const lines = text.split(/\r?\n/);
  const chunks = [];
  let buf = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length > maxChars && buf.length) {
      chunks.push(buf.join("\n"));
      buf = [];
      len = 0;
    }
    buf.push(line);
    len += line.length + 1;
  }
  if (buf.length) chunks.push(buf.join("\n"));

  const total = Math.min(chunks.length, maxChunks);
  const now = new Date().toISOString();
  return chunks.slice(0, maxChunks).map((chunk, i) => {
    const preview = chunk.replace(/\s+/g, " ").trim().slice(0, 36);
    return {
      id: crypto.randomUUID(),
      title: `${metadata?.title || "자료"} (${i + 1}/${total}) — ${preview}…`,
      content: chunk, // ← 원문 그대로. 무손실.
      my_take: "",
      why_saved: "참고 자료 원문 보존 (검색용 조각)",
      type: "reference",
      topics: [],
      half_life: "permanent",
      confidence: 1,
      conditions: [],
      implications: [],
      source: {
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
  });
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
