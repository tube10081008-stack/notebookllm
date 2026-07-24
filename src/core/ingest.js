// src/core/ingest.js — 수집 파이프라인 (트랜잭션적 순서 보장)
//
// Raw 보존 → 증류 → 노트 저장 → 임베딩 → ★링크 제안(그래프 엣지)★ → 이벤트 기록
//
// v1 문제 ①의 답이 여기 있다: proposeLinks는 import 장식이 아니라 파이프라인의 필수 단계다.
// 순서 원칙(P-Reinforce): canonical(raw, note)을 먼저 확정하고 derived(vector)와
// enrichment(edges)는 그 뒤에. 어느 단계가 실패해도 원문과 노트는 이미 안전하다.
import * as ws from "../storage/workspace.js";
import { getLLM } from "../llm/index.js";
import { distill, chunkReference, classifyWithFallback } from "./distill.js";
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
    // 휴리스틱이 확신하면 즉시, 애매하면 LLM에 위임 (논문 4,5)
    const c = await classifyWithFallback(parsed, { llm });
    effectiveMode = c.mode;
    classifyReason = c.reason;
  }

  // 하이브리드 레이어: 한 소스에서 필요한 처리를 동시에 수행한다.
  //   distill  → 개념 노트(이해 + 그래프 연결)
  //   preserve → 참고 조각(원문 무손실 + 정확 검색)
  // concept=distill만 · reference=preserve만 · hybrid=둘 다.
  // 개념 노트를 먼저(그래프 링크가 참고 조각을 향하지 않도록), 참고 조각을 나중에.
  const doDistill = effectiveMode === "concept" || effectiveMode === "hybrid";
  const doPreserve = effectiveMode === "reference" || effectiveMode === "hybrid";
  const notes = [];
  if (doDistill) notes.push(...await distill({ ...parsed, metadata }, existingTopics, station.agent));
  if (doPreserve) notes.push(...chunkReference({ ...parsed, metadata }));

  // 3) 임베딩(병렬) → 링크 제안 → 배치 저장.
  //    서버리스 60초 제한 대응: 노트당 커밋(N개) 대신 커밋 1개, 임베딩은 병렬화.
  for (const note of notes) note.station_id = sid;

  // 3a) 전 노트 임베딩 (동시성 제한 병렬)
  const CONC = 5;
  const embeddings = new Array(notes.length);
  for (let i = 0; i < notes.length; i += CONC) {
    const slice = notes.slice(i, i + CONC);
    const vecs = await Promise.all(slice.map((nt) => llm.embedOne(`${nt.title} ${nt.content}`)));
    for (let j = 0; j < slice.length; j++) embeddings[i + j] = vecs[j];
  }

  // 3b) 벡터 일괄 저장 (로컬 1회 쓰기)
  await ws.saveVectorsBatch(sid, notes.map((note, i) => ({
    nid: note.id,
    embedding: embeddings[i],
    meta: { title: note.title, type: note.type, created_at: note.created_at, confidence: note.confidence },
  })), { model: embedModel, dims });

  // 3c) 링크 제안 — 개념 노트만 (참고 조각은 검색만). 기존 벡터와 비교.
  const graph = await ws.loadGraph(sid);
  const store = await ws.loadVectors(sid);
  let newEdges = 0;
  for (let i = 0; i < notes.length; i++) {
    if (notes[i].type === "reference") continue;
    const edges = await proposeLinks(notes[i], embeddings[i], store);
    if (edges.length > 0) { graph.edges.push(...edges); newEdges += edges.length; }
  }

  // 3d) 노트 + 벡터 스냅샷을 같은 커밋으로 (github: 커밋 1개, M4) + 그래프 + 이벤트
  await ws.saveIngestBatch(sid, notes);
  if (newEdges > 0) await ws.saveGraph(sid, graph);
  await ws.appendEvents(sid, [
    ...notes.map((n) => ({ ts: new Date().toISOString(), type: "apply", note_id: n.id, title: n.title })),
    { ts: new Date().toISOString(), type: "distill.complete", raw_ref: rawName, notes: notes.length, edges: newEdges, mode: effectiveMode },
  ]);

  return { notes, edges: newEdges, rawRef: rawName, mode: effectiveMode, autoDetected: mode === "auto", reason: classifyReason };
}
