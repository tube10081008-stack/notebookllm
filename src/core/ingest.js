// src/core/ingest.js — 수집 파이프라인 (트랜잭션적 순서 보장)
//
// Raw 보존 → 증류 → 노트 저장 → 임베딩 → ★링크 제안(그래프 엣지)★ → 이벤트 기록
//
// v1 문제 ①의 답이 여기 있다: proposeLinks는 import 장식이 아니라 파이프라인의 필수 단계다.
// 순서 원칙(P-Reinforce): canonical(raw, note)을 먼저 확정하고 derived(vector)와
// enrichment(edges)는 그 뒤에. 어느 단계가 실패해도 원문과 노트는 이미 안전하다.
import * as ws from "../storage/workspace.js";
import { getLLM } from "../llm/index.js";
import { distill, chunkReference, classifyContent } from "./distill.js";
import { proposeLinks } from "./links.js";
import { assertEmbeddingCompatible, ensureVectorStore } from "./retrieve.js";

// mode: "auto"(기본, 에이전트가 판단) | "concept"(개념 증류) | "reference"(목록·표 원문 보존)
export async function ingest(station, parsed, { mode = "auto" } = {}) {
  const sid = station.id;
  const llm = getLLM();
  const { embedModel, dims } = llm.info();

  // 0) 벡터 캐시 보장(콜드 스타트 재구축) + 모델 정합성 선확인
  const vectorStore = await ensureVectorStore(sid);
  assertEmbeddingCompatible(vectorStore);

  // 1) 원문 무수정 영구 보관 (불변식 1)
  const safeTitle = (parsed.metadata?.title || "source")
    .replace(/[^a-zA-Z0-9가-힣_-]/g, "_")
    .slice(0, 50);
  const rawName = `raw_${Date.now()}_${safeTitle}`;
  await ws.saveRawSource(sid, rawName, {
    original_parsed: parsed,
    saved_at: new Date().toISOString(),
  });
  await ws.appendEvent(sid, "capture", { raw_ref: rawName, title: parsed.metadata?.title || "" });

  // 2) 증류 (에이전트 성격 반영). 노트는 raw_ref로 원문까지 역추적 가능 (불변식 6)
  const existingNotes = await ws.loadAllNotes(sid);
  const topicCount = {};
  for (const n of existingNotes) for (const t of n.topics || []) topicCount[t] = (topicCount[t] || 0) + 1;
  const existingTopics = Object.keys(topicCount).sort((a, b) => topicCount[b] - topicCount[a]).slice(0, 40);

  const metadata = { ...(parsed.metadata || {}), raw_ref: rawName };
  // mode=auto면 에이전트가 구조를 보고 판단 (사용자에게 분별을 떠넘기지 않음)
  let effectiveMode = mode;
  let classifyReason = null;
  if (mode === "auto") {
    const c = classifyContent(parsed);
    effectiveMode = c.mode;
    classifyReason = c.reason;
  }
  // 참고 자료(목록·표)는 원문을 손실 없이 청킹, 개념 자료는 에이전트 관점으로 증류
  const isReference = effectiveMode === "reference";
  const notes = isReference
    ? chunkReference({ ...parsed, metadata })
    : await distill({ ...parsed, metadata }, existingTopics, station.agent);

  // 3) 노트 저장(canonical) → 임베딩(derived) → 링크 제안(enrichment)
  const graph = await ws.loadGraph(sid);
  const created = [];
  const applyEvents = [];
  let newEdges = 0;

  for (const note of notes) {
    note.station_id = sid;
    await ws.saveNote(sid, note);

    const embedding = await llm.embedOne(`${note.title} ${note.content}`);
    await ws.saveVector(sid, note.id, embedding, {
      model: embedModel,
      dims,
      meta: { title: note.title, type: note.type, created_at: note.created_at, confidence: note.confidence },
    });

    // ★ v2의 그래프는 살아 있다: 기존 벡터들과 비교해 관계 엣지를 만든다
    // 참고 자료 조각끼리는 그래프 링크가 노이즈일 뿐 — 개념 노트에서만 링크 제안
    let edges = [];
    if (!isReference) {
      const store = await ws.loadVectors(sid);
      edges = await proposeLinks(note, embedding, store);
      if (edges.length > 0) {
        graph.edges.push(...edges);
        newEdges += edges.length;
      }
    }

    applyEvents.push({ ts: new Date().toISOString(), type: "apply", note_id: note.id, title: note.title, edges: edges.length });
    created.push(note);
  }

  if (newEdges > 0) await ws.saveGraph(sid, graph);

  // 이벤트는 일괄 기록 — github 백엔드에서 노트당 커밋 1개씩 아끼는 것이
  // 서버리스 시간 제한(60초) 안에서 승인 파이프라인을 완주시키는 데 중요하다
  await ws.appendEvents(sid, [
    ...applyEvents,
    { ts: new Date().toISOString(), type: "distill.complete", raw_ref: rawName, notes: created.length, edges: newEdges, mode: effectiveMode },
  ]);

  return { notes: created, edges: newEdges, rawRef: rawName, mode: effectiveMode, autoDetected: mode === "auto", reason: classifyReason };
}
