// src/core/answer.js — 인용 기반 답변 생성 (+ 대화 메모리)
// v1 /query의 좋은 프롬프트(볼드 인용 규칙)를 계승, 구조화 출력으로 강화.
import * as ws from "../storage/workspace.js";
import { getLLM } from "../llm/index.js";

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    gaps: { type: "array", items: { type: "string" } },
  },
  required: ["answer", "confidence"],
};

export async function synthesizeAnswer({ sid, station, question, ranked, behavior }) {
  const noteContents = ranked.map((r, i) => ({
    ...r.note,
    relevance: r.score,
    viaGraph: r.viaGraph,
    index: i + 1,
  }));

  const context = noteContents
    .map((n) => `[${n.index}] "${n.title}" (타입: ${n.type}, confidence: ${n.confidence}${n.viaGraph ? ", 그래프 연결로 발견" : ""}): ${(n.content || "").slice(0, 2000)}`)
    .join("\n\n---\n\n");

  // 대화 메모리 (append-only 아카이브의 꼬리만)
  const memorySize = behavior?.answer?.chatMemory || 5;
  const recentChats = await ws.loadChats(sid, memorySize);
  const chatMemoryContext = recentChats.length
    ? `\n\n[이전 대화 맥락 (최근 ${recentChats.length}개)]\n` +
      recentChats.map((c, i) => `대화${i + 1}) 사용자: ${c.question || ""}\n에이전트: ${(c.answer || "").slice(0, 500)}`).join("\n---\n")
    : "";

  const system = `${station.agent.system_prompt}

당신은 "${station.name}" 스테이션의 에이전트입니다.
제공된 노트를 바탕으로 답변하세요.

[답변 스타일 및 인용 볼드체 규칙]
- 노트를 바탕으로 핵심 개념, 키워드 혹은 주장을 서술할 때 인용 번호와 함께 반드시 볼드(Bold)체로 감싸서 작성하세요.
- 형식 예시: **'핵심 개념(영문명)'[번호]**
- 여러 노트를 인용할 때는 **'핵심 개념'[번호1][번호2]** 형태로 묶으세요.

${behavior?.answer?.style || ""}

[대화 메모리 규칙]
- 이전 대화가 있으면 맥락을 이어가세요. 반복하지 말고 새로운 관점이나 깊이를 더하세요.

JSON 객체로만 응답하세요: {"answer":"답변","confidence":"high|medium|low","gaps":["지식이 부족한 영역"]}`;

  const parts = [];
  if (chatMemoryContext) parts.push(chatMemoryContext);
  if (noteContents.length > 0) parts.push(`\n\n[참고 노트]\n${context}`);

  const prompt = parts.length
    ? `질문: ${question}${parts.join("")}`
    : `질문: ${question}\n\n(참고 노트 없음, 이전 대화 없음 — 일반 지식으로 답변하되 지식 베이스가 비어 있음을 알려주세요)`;

  let synthesized;
  try {
    synthesized = await getLLM().chat({ system, prompt, json: true, schema: ANSWER_SCHEMA });
  } catch (err) {
    synthesized = {
      answer: `관련 노트 ${noteContents.length}개를 찾았지만 답변 합성에 실패했습니다: ${err.message}`,
      confidence: "low",
      gaps: [],
    };
  }

  const citations = noteContents.slice(0, 5).map((n) => ({
    index: n.index,
    noteId: n.id,
    title: n.title,
    relevance: Math.round(n.relevance * 100) / 100,
    viaGraph: !!n.viaGraph,
    source: n.source, // 불변식 6: 답변은 항상 원문까지 추적 가능해야 한다
  }));

  return {
    answer: synthesized.answer || "",
    confidence: synthesized.confidence || "medium",
    gaps: synthesized.gaps || [],
    citations,
    notesUsed: noteContents.length,
  };
}
