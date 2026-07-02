// src/core/council.js — 협의회 모드 (Day 7 멀티에이전트: 여러 특화 두뇌의 관점 병렬 수렴)
import * as ws from "../storage/workspace.js";
import { getLLM } from "../llm/index.js";
import * as stations from "./stations.js";
import { cosine } from "./similarity.js";

export async function runCouncil(question, stationIds = []) {
  const all = await stations.getAll();
  const targets = stationIds.length > 0 ? all.filter((s) => stationIds.includes(s.id)) : all;

  if (targets.length === 0) {
    return { question, responses: [], message: "참여할 스테이션이 없습니다." };
  }

  // 질문 임베딩은 한 번만 (v1은 이 함수 안에서도 재사용했다 — 계승)
  const qEmbed = await getLLM().embedOne(question);

  const responses = await Promise.all(targets.map(async (station) => {
    try {
      const vectorStore = await ws.loadVectors(station.id);
      const scored = Object.entries(vectorStore.items || {})
        .map(([id, item]) => ({ id, score: cosine(qEmbed, item.v) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      const contextParts = [];
      for (let i = 0; i < scored.length; i++) {
        const note = await ws.loadNote(station.id, scored[i].id);
        if (note) contextParts.push(`[${i + 1}] "${note.title}": ${(note.content || "").slice(0, 400)}`);
      }
      const context = contextParts.join("\n\n");
      const hasContext = context.length > 0;

      const system = `${station.agent.system_prompt}

당신은 "${station.name}" 스테이션의 에이전트입니다.
${hasContext ? "아래 참고 자료를 기반으로 답변하세요." : "해당 주제에 대한 자료가 없지만, 일반적인 관점에서 의견을 제시하세요."}
답변은 3~5문장으로 간결하게. 한국어로 답변하되 기술 용어는 영어로 유지.`;

      const prompt = hasContext
        ? `질문: ${question}\n\n참고 자료:\n${context}`
        : `질문: ${question}\n\n(참고: 이 주제에 대한 저장된 자료가 없습니다.)`;

      const answer = await getLLM().chat({ system, prompt });

      return {
        stationId: station.id,
        stationName: station.name,
        agent: { name: station.agent.name, avatar: station.agent.avatar, expertise: station.agent.expertise },
        answer,
        notesUsed: contextParts.length,
        hasContext,
      };
    } catch (err) {
      return {
        stationId: station.id,
        stationName: station.name,
        agent: { name: station.agent.name, avatar: station.agent.avatar, expertise: station.agent.expertise },
        answer: `답변 생성 중 오류: ${err.message}`,
        notesUsed: 0,
        hasContext: false,
        error: true,
      };
    }
  }));

  return { question, responses, timestamp: new Date().toISOString() };
}
