// lib/distiller.js — 콘텐츠 증류기 (파싱된 콘텐츠 → 원자적 노트)
import { v4 as uuidv4 } from "uuid";
import { generateText, embedText } from "./gemini.js";
import * as vectorStore from "./vector-store.js";
import * as graph from "./graph.js";
import { getAgentBehavior } from "./agent-config.js";

// ── Half-life 기본값 (타입별) ────────────────────────
const DEFAULT_HALF_LIFE = {
  fact: "permanent",
  concept: "permanent",
  procedure: "5yr",
  opinion: "6mo",
  temporal: "1yr",
};

// ── 콘텐츠 증류 ─────────────────────────────────────
export async function distill(parsedContent, existingTopics = [], agent = null) {
  const { content, metadata } = parsedContent;

  // 콘텐츠가 너무 짧으면 그대로 단일 노트로
  if (content.length < 100) {
    return [createSimpleNote(content, metadata)];
  }

  // ── 에이전트별 행동 설정 로드 ──
  const behavior = agent ? getAgentBehavior(agent.personality) : null;
  const distillConfig = behavior?.distill || { maxNotes: 5, preferredTypes: ["fact", "concept"], minConfidence: 0.6, instruction: "" };

  // 에이전트 성격 반영 (고도화: 증류 전략까지 주입)
  const agentContext = agent
    ? `\n\n당신의 이름은 "${agent.name}"이고, ${agent.tone} 말투로 작성합니다.
전문 분야: ${agent.expertise}
content 필드를 작성할 때 당신의 전문성과 관점을 반영하세요.

[증류 전략]
${distillConfig.instruction}
- 선호 타입: ${distillConfig.preferredTypes.join(", ")} (가능하면 이 타입들을 우선 사용하세요)
- 최소 신뢰도: ${distillConfig.minConfidence} (이 기준 이하의 불확실한 정보는 제외하세요)`
    : "";

  // LLM에게 원자적 개념으로 분해 요청
  const systemPrompt = `당신은 지식 관리 전문가입니다.${agentContext}
주어진 콘텐츠를 원자적 개념(Atomic Concept) 단위로 분해하세요.
각 개념은 하나의 독립적인 지식 단위여야 합니다.

기존 토픽 목록 (참고용): ${existingTopics.join(", ") || "없음"}

반드시 다음 JSON 배열 형식으로만 응답하세요 (마크다운 코드 블럭 없이):
[
  {
    "title": "간결한 제목 (한국어, 기술 용어는 English 유지)",
    "content": "핵심 내용을 자신만의 표현으로 재작성. 한국어로 작성하되 기술 용어는 English로.",
    "why_saved": "이 지식이 왜 중요한지 한 줄 설명",
    "type": "fact|concept|procedure|opinion|temporal",
    "topics": ["토픽1", "토픽2"],
    "confidence": 0.8,
    "conditions": ["이 지식이 유효한 조건"],
    "implications": ["이 지식의 함의"]
  }
]

규칙:
- 최소 1개, 최대 ${distillConfig.maxNotes}개의 노트로 분해
- 각 노트는 하나의 핵심 아이디어만 담을 것
- type은 content 성격에 맞게 선택
- confidence는 출처 신뢰도에 따라 ${distillConfig.minConfidence}~1.0
- 한국어로 작성하되, 기술 용어(API, framework, model 등)는 영어 그대로 유지`;

  const prompt = `다음 콘텐츠를 원자적 개념으로 분해해주세요:

출처: ${metadata.title || "알 수 없음"}
URL: ${metadata.url || "없음"}

---
${content.slice(0, 15000)}
---`;

  let distilled;
  try {
    const raw = await generateText(prompt, systemPrompt);
    // JSON 파싱 (마크다운 코드 블럭 처리)
    const cleaned = raw
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();
    distilled = JSON.parse(cleaned);
  } catch (err) {
    console.warn("⚠️ LLM 증류 실패, 단일 노트로 폴백:", err.message);
    return [createSimpleNote(content, metadata)];
  }

  if (!Array.isArray(distilled) || distilled.length === 0) {
    return [createSimpleNote(content, metadata)];
  }

  // 각 증류 결과를 표준 노트 형식으로 변환
  const notes = distilled.map((item) => {
    const type = item.type || "fact";
    return {
      id: uuidv4(),
      title: item.title || "제목 없음",
      content: item.content || "",
      my_take: "",
      why_saved: item.why_saved || "",
      type,
      topics: item.topics || [],
      half_life: DEFAULT_HALF_LIFE[type] || "permanent",
      confidence: Math.min(1, Math.max(0, item.confidence ?? 0.8)),
      conditions: item.conditions || [],
      implications: item.implications || [],
      source: {
        title: metadata.title || "",
        url: metadata.url || "",
        author: metadata.author || "",
        date: metadata.date || new Date().toISOString(),
      },
      links: [],
      created_at: new Date().toISOString(),
      last_accessed: new Date().toISOString(),
      access_count: 0,
      archived: false,
    };
  });

  return notes;
}

// ── 링크 제안 ────────────────────────────────────────
export async function proposeLinks(newNote, existingNotes = []) {
  const totalNotes = existingNotes.length;
  const links = [];

  // Cold start: 기존 노트가 없으면 링크 불필요
  if (totalNotes === 0) return links;

  try {
    // 1) 벡터 유사도로 후보 찾기
    const embedding = await embedText(
      `${newNote.title} ${newNote.content}`,
    );
    const similar = vectorStore.search(embedding, 10);

    // 유사도 0.5 이상만 후보
    const candidates = similar.filter(
      (s) => s.score > 0.5 && s.id !== newNote.id,
    );

    if (candidates.length === 0) return links;

    // 2) 상위 후보들의 정보 모으기
    const candidateInfo = candidates
      .slice(0, 5)
      .map((c) => {
        const node = graph.getNode(c.id);
        if (!node) return null;
        return {
          id: c.id,
          title: node.title,
          type: node.type,
          score: c.score,
        };
      })
      .filter(Boolean);

    if (candidateInfo.length === 0) return links;

    // 3) LLM에게 관계 유형 판단 요청
    const systemPrompt = `당신은 지식 그래프 관계 분석 전문가입니다.
새 노트와 기존 노트 사이의 관계를 분석하세요.

관계 유형:
- supports: 지지하거나 보완하는 관계
- contradicts: 모순되는 관계
- applies_to: 적용되는 관계
- derived_from: 파생된 관계
- obsoletes: 대체하는 관계
- related_to: 일반적 관련

반드시 다음 JSON 배열 형식으로만 응답하세요 (마크다운 코드 블럭 없이):
[
  { "target_id": "...", "relation": "supports|contradicts|applies_to|derived_from|obsoletes|related_to" }
]

관련성이 낮으면 빈 배열 []을 반환하세요.`;

    const prompt = `새 노트:
제목: ${newNote.title}
내용: ${newNote.content.slice(0, 500)}
타입: ${newNote.type}

기존 노트 후보:
${candidateInfo.map((c) => `- [${c.id}] "${c.title}" (${c.type}, 유사도: ${c.score.toFixed(2)})`).join("\n")}`;

    const raw = await generateText(prompt, systemPrompt);
    const cleaned = raw
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();
    const proposed = JSON.parse(cleaned);

    if (Array.isArray(proposed)) {
      for (const link of proposed) {
        if (link.target_id && link.relation) {
          links.push({
            target_id: link.target_id,
            relation: link.relation,
          });
        }
      }
    }
  } catch (err) {
    console.warn("⚠️ 링크 제안 실패:", err.message);
  }

  return links;
}

// ── 단순 노트 생성 (폴백용) ──────────────────────────
function createSimpleNote(content, metadata) {
  return {
    id: uuidv4(),
    title: metadata.title || content.slice(0, 50),
    content,
    my_take: "",
    why_saved: "직접 입력된 콘텐츠",
    type: "fact",
    topics: [],
    half_life: "permanent",
    confidence: 0.7,
    conditions: [],
    implications: [],
    source: {
      title: metadata.title || "",
      url: metadata.url || "",
      author: metadata.author || "",
      date: metadata.date || new Date().toISOString(),
    },
    links: [],
    created_at: new Date().toISOString(),
    last_accessed: new Date().toISOString(),
    access_count: 0,
    archived: false,
  };
}

export { DEFAULT_HALF_LIFE };
