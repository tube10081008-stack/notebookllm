// lib/council.js — 협의회(Council) 모드 + 크로스 스테이션 검색
import { generateText, embedText } from "./gemini.js";
import * as stationManager from "./station-manager.js";
import { loadVectors as loadStationVectors, loadAllNotes as loadStationNotes } from "./db.js";

// ── Cosine Similarity (인라인) ───────────────────────
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, nA = 0, nB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; nA += a[i] * a[i]; nB += b[i] * b[i];
  }
  const d = Math.sqrt(nA) * Math.sqrt(nB);
  return d === 0 ? 0 : dot / d;
}

// ── 협의회 모드 ──────────────────────────────────────
// 여러 에이전트에게 동시에 질문 → 각자의 관점에서 답변
export async function runCouncil(question, stationIds = []) {
  const allStations = stationManager.getAll();
  const targets = stationIds.length > 0
    ? allStations.filter(s => stationIds.includes(s.id))
    : allStations;

  if (targets.length === 0) {
    return { question, responses: [], message: "참여할 스테이션이 없습니다." };
  }

  // 질문 임베딩
  const qEmbed = await embedText(question);

  // 각 스테이션의 에이전트가 자기 지식을 기반으로 답변
  const responsePromises = targets.map(async (station) => {
    try {
      // 해당 스테이션의 벡터 검색
      const vectors = await loadStationVectors(station.id);
      const ids = Object.keys(vectors);

      // 유사도 계산 → 상위 5개
      const scored = ids
        .map(id => ({ id, score: cosine(qEmbed, vectors[id]?.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      // 노트 내용 로드
      const notes = await loadStationNotes(station.id);
      const noteMap = {};
      for (const n of notes) noteMap[n.id] = n;

      const context = scored
        .map((s, i) => {
          const note = noteMap[s.id];
          return note
            ? `[${i + 1}] "${note.title}": ${note.content?.slice(0, 400) || ""}`
            : "";
        })
        .filter(Boolean)
        .join("\n\n");

      const hasContext = context.length > 0;

      // 에이전트 성격으로 답변 생성
      const systemPrompt = `${station.agent.system_prompt}

당신은 "${station.name}" 스테이션의 에이전트입니다.
${hasContext ? "아래 참고 자료를 기반으로 답변하세요." : "해당 주제에 대한 자료가 없지만, 일반적인 관점에서 의견을 제시하세요."}
답변은 3~5문장으로 간결하게. 한국어로 답변하되 기술 용어는 영어로 유지.`;

      const prompt = hasContext
        ? `질문: ${question}\n\n참고 자료:\n${context}`
        : `질문: ${question}\n\n(참고: 이 주제에 대한 저장된 자료가 없습니다. 일반적 관점에서 답변해주세요.)`;

      const answer = await generateText(prompt, systemPrompt);

      return {
        stationId: station.id,
        stationName: station.name,
        agent: {
          name: station.agent.name,
          avatar: station.agent.avatar,
          expertise: station.agent.expertise,
        },
        level: station.gamification.level,
        answer,
        notesUsed: scored.length,
        hasContext,
      };
    } catch (err) {
      return {
        stationId: station.id,
        stationName: station.name,
        agent: {
          name: station.agent.name,
          avatar: station.agent.avatar,
          expertise: station.agent.expertise,
        },
        level: station.gamification.level,
        answer: `답변 생성 중 오류가 발생했습니다: ${err.message}`,
        notesUsed: 0,
        hasContext: false,
        error: true,
      };
    }
  });

  const responses = await Promise.all(responsePromises);

  return { question, responses, timestamp: new Date().toISOString() };
}

// ── 크로스 스테이션 검색 ─────────────────────────────
// 모든 스테이션에서 관련 노트를 검색
export async function crossStationSearch(question, excludeStationId = null) {
  const qEmbed = await embedText(question);
  const allStations = stationManager.getAll();
  const results = [];

  for (const station of allStations) {
    if (station.id === excludeStationId) continue;

    const vectors = await loadStationVectors(station.id);
    const ids = Object.keys(vectors);

    for (const id of ids) {
      const score = cosine(qEmbed, vectors[id]?.embedding);
      if (score > 0.5) {
        results.push({
          noteId: id,
          stationId: station.id,
          stationName: station.name,
          agentName: station.agent.name,
          agentAvatar: station.agent.avatar,
          score,
          title: vectors[id]?.metadata?.title || id,
        });
      }
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

// ── 에이전트 위임 제안 ───────────────────────────────
// 현재 스테이션에 관련 지식이 부족할 때, 다른 스테이션 추천
export function suggestDelegation(currentStationId, queryTopics = []) {
  const allStations = stationManager.getAll();
  const suggestions = [];

  for (const station of allStations) {
    if (station.id === currentStationId) continue;
    // 에이전트 전문 분야와 쿼리 토픽의 연관성 (간단한 키워드 매칭)
    const expertise = station.agent.expertise?.toLowerCase() || "";
    const matchScore = queryTopics.reduce((score, topic) => {
      return score + (expertise.includes(topic.toLowerCase()) ? 1 : 0);
    }, 0);

    if (matchScore > 0 || station.stats.note_count > 10) {
      suggestions.push({
        stationId: station.id,
        stationName: station.name,
        agent: station.agent,
        relevance: matchScore,
        noteCount: station.stats.note_count,
      });
    }
  }

  return suggestions.sort((a, b) => b.relevance - a.relevance).slice(0, 3);
}
