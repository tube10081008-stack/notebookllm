// src/core/retrieve.js — 유일한 검색 경로 (v1 문제 ②의 답)
//
// v1에는 두 개의 검색이 있었다: 죽어 있던 좋은 코드(retriever.js: 그래프 확장 + 종합 랭킹)와
// 실제로 쓰이던 나쁜 코드(server.js 인라인: 단순 코사인). v2는 좋은 쪽 하나만 남긴다.
//
// 파이프라인: 벡터 topK → 그래프 2-hop 확장 → 종합 랭킹 → 반감기 패널티
// ⚠️ 모든 가중치는 가설이다. 변경 시 `npm run eval`로 회귀를 숫자로 확인할 것 (문제 ⑪).
import * as ws from "../storage/workspace.js";
import { getLLM } from "../llm/index.js";
import { getAgentBehavior } from "./personas.js";
import { cosine } from "./similarity.js";

const HALF_LIFE_MS = {
  permanent: Infinity,
  "5yr": 5 * 365 * 24 * 3600 * 1000,
  "1yr": 365 * 24 * 3600 * 1000,
  "6mo": 182 * 24 * 3600 * 1000,
};

export function isExpired(note, now = Date.now()) {
  const ms = HALF_LIFE_MS[note.half_life] ?? Infinity;
  if (ms === Infinity) return false;
  return now - new Date(note.created_at).getTime() > ms;
}

// 벡터 저장소 보장 (하이브리드 영속 모드의 핵심 — 불변식 2의 실전 효용)
// github 백엔드의 콜드 스타트에서는 /tmp 벡터 캐시가 비어 있다.
// canonical인 notes에서 derived인 vectors를 그 자리에서 재구축한다.
export async function ensureVectorStore(sid) {
  let store = await ws.loadVectors(sid);
  if (Object.keys(store.items || {}).length > 0) return store;

  const notes = await ws.loadAllNotes(sid);
  const active = notes.filter((n) => !n.archived);
  if (active.length === 0) return store;

  const llm = getLLM();
  const { embedModel, dims } = llm.info();
  console.log(`🔁 벡터 캐시 재구축: ${sid} — 노트 ${active.length}개 → ${embedModel}`);
  const items = {};
  for (const note of active) {
    items[note.id] = {
      v: await llm.embedOne(`${note.title} ${note.content}`),
      title: note.title, type: note.type,
      created_at: note.created_at, confidence: note.confidence,
    };
  }
  store = { model: embedModel, dims, items };
  await ws.replaceVectorStore(sid, store);
  return store;
}

// 임베딩 모델 정합성 확인 (문제 ⑩): 벡터가 다른 모델로 만들어졌다면 검색은 무의미하다 — 거부한다.
export function assertEmbeddingCompatible(vectorStore) {
  const current = getLLM().info();
  if (vectorStore.model && vectorStore.model !== current.embedModel) {
    const err = new Error(
      `이 스테이션의 벡터는 "${vectorStore.model}"로 생성되었지만 현재 임베딩 모델은 "${current.embedModel}"입니다. ` +
      `\`npm run reindex\`로 전량 재임베딩 후 질의하세요.`
    );
    err.code = "EMBED_MODEL_MISMATCH";
    throw err;
  }
}

// 질문 임베딩 없이 순수 랭킹만 수행하는 코어 (eval에서 재사용 — LLM-free 평가의 전제)
export function rankCandidates({ qEmbed, vectorStore, graph, notesById, behavior, now = Date.now() }) {
  const search = behavior?.search || { topK: 10, recencyWeight: 0, confidenceWeight: 0.2 };

  // 1) 벡터 유사도
  const vectorScored = Object.entries(vectorStore.items || {})
    .map(([id, item]) => ({ id, vectorScore: cosine(qEmbed, item.v) }))
    .sort((a, b) => b.vectorScore - a.vectorScore)
    .slice(0, search.topK);

  const candidates = new Map(); // id → { vectorScore, viaGraph }
  for (const v of vectorScored) candidates.set(v.id, { vectorScore: v.vectorScore, viaGraph: false });

  // 2) 그래프 2-hop 확장 (top5 기점) — 벡터가 놓친 연결 지식을 회수한다
  const adjacency = buildAdjacency(graph);
  for (const seed of vectorScored.slice(0, 5)) {
    for (const { id, depth } of walk(adjacency, seed.id, 2)) {
      if (!candidates.has(id)) {
        candidates.set(id, { vectorScore: 0.3 / depth, viaGraph: true });
      }
    }
  }

  // 3) 종합 랭킹
  const ranked = [];
  for (const [id, c] of candidates) {
    const note = notesById.get(id);
    if (!note || note.archived) continue;

    const confidence = note.confidence ?? 0.7;
    const ageMs = now - new Date(note.created_at).getTime();
    const recency = Math.max(0, 1 - ageMs / (365 * 24 * 3600 * 1000));
    const access = Math.log((note.access_count || 0) + 1) / 5;

    let score =
      c.vectorScore * 0.55 +
      confidence * (search.confidenceWeight ?? 0.2) +
      recency * (search.recencyWeight ?? 0) +
      Math.min(access, 1) * 0.1;

    // 지식은 썩는다: 반감기가 지난 노트는 패널티 (삭제가 아니라 강등 — 불변식 5)
    if (isExpired(note, now)) score *= 0.5;

    ranked.push({ id, note, score, vectorScore: c.vectorScore, viaGraph: c.viaGraph });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, search.topK);
}

function buildAdjacency(graph) {
  const adj = new Map();
  for (const e of graph?.edges || []) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    if (!adj.has(e.target)) adj.set(e.target, []);
    adj.get(e.source).push(e.target);
    adj.get(e.target).push(e.source);
  }
  return adj;
}

function* walk(adjacency, start, maxDepth) {
  const visited = new Set([start]);
  let frontier = [start];
  for (let depth = 1; depth <= maxDepth; depth++) {
    const next = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) || []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          next.push(neighbor);
          yield { id: neighbor, depth };
        }
      }
    }
    frontier = next;
  }
}

// 스테이션에 대한 전체 검색 (질문 → 랭킹된 노트 목록)
export async function retrieve(sid, question, agent) {
  const vectorStore = await ensureVectorStore(sid);
  assertEmbeddingCompatible(vectorStore);

  const [qEmbed, allNotes, graph] = await Promise.all([
    getLLM().embedOne(question),
    ws.loadAllNotes(sid),
    ws.loadGraph(sid),
  ]);

  const notesById = new Map(allNotes.map((n) => [n.id, n]));
  const behavior = getAgentBehavior(agent?.personality);
  const ranked = rankCandidates({ qEmbed, vectorStore, graph, notesById, behavior });

  // 인용된 상위 노트의 접근 기록 갱신 (랭킹 신호 축적)
  const now = new Date().toISOString();
  await Promise.all(ranked.slice(0, 3).map(({ note }) => {
    note.access_count = (note.access_count || 0) + 1;
    note.last_accessed = now;
    return ws.saveNote(sid, note);
  }));

  return { ranked, qEmbed, behavior };
}

// 크로스 스테이션 검색 (질문 임베딩 재사용 — v1은 스테이션마다 재임베딩했다)
export async function crossStationSearch(qEmbed, stations, excludeSid = null) {
  const results = [];
  for (const station of stations) {
    if (station.id === excludeSid) continue;
    try {
      const vectorStore = await ws.loadVectors(station.id);
      if (vectorStore.model && vectorStore.model !== getLLM().info().embedModel) continue;
      for (const [id, item] of Object.entries(vectorStore.items || {})) {
        const score = cosine(qEmbed, item.v);
        if (score > 0.5) {
          results.push({
            noteId: id, stationId: station.id, stationName: station.name,
            agentName: station.agent.name, agentAvatar: station.agent.avatar,
            score, title: item.title || id,
          });
        }
      }
    } catch { /* 스테이션 하나가 깨져도 전체 검색은 계속 */ }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 10);
}
