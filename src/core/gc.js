// src/core/gc.js — 지식 정원사 (Garbage Collection → 정확히는 "제안서 작성자")
//
// 불변식 5: 에이전트는 사용자 동의 없이 진실을 파괴하지 않는다.
// GC는 중복·고아·만료·모순 후보를 찾아 **보고서만** 만든다. 처분은 인간의 결정.
import * as ws from "../storage/workspace.js";
import { cosine } from "./similarity.js";
import { isExpired } from "./retrieve.js";

export async function runGC(sid) {
  const [notes, vectorStore, graph] = await Promise.all([
    ws.loadAllNotes(sid),
    ws.loadVectors(sid),
    ws.loadGraph(sid),
  ]);

  const active = notes.filter((n) => !n.archived);
  const report = {
    timestamp: new Date().toISOString(),
    station_id: sid,
    totals: { notes: notes.length, active: active.length, edges: graph.edges.length },
    duplicates: [],
    orphans: [],
    expired: [],
    contradictions: [],
  };

  // 1) 중복 후보: 벡터 유사도 > 0.92
  const entries = Object.entries(vectorStore.items || {});
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const score = cosine(entries[i][1].v, entries[j][1].v);
      if (score > 0.92) {
        report.duplicates.push({
          a: { id: entries[i][0], title: entries[i][1].title },
          b: { id: entries[j][0], title: entries[j][1].title },
          similarity: Math.round(score * 1000) / 1000,
        });
      }
    }
  }

  // 2) 고아 노드: 엣지가 하나도 없는 노트
  const linked = new Set();
  for (const e of graph.edges) { linked.add(e.source); linked.add(e.target); }
  report.orphans = active
    .filter((n) => !linked.has(n.id))
    .map((n) => ({ id: n.id, title: n.title, created_at: n.created_at }));

  // 3) 반감기 만료
  report.expired = active
    .filter((n) => isExpired(n))
    .map((n) => ({ id: n.id, title: n.title, type: n.type, half_life: n.half_life, created_at: n.created_at }));

  // 4) 모순 후보: contradicts 엣지 그대로 표면화
  report.contradictions = graph.edges
    .filter((e) => e.relation === "contradicts")
    .map((e) => ({ source: e.source, target: e.target, proposed_at: e.proposed_at }));

  report.summary = {
    duplicateCandidates: report.duplicates.length,
    orphans: report.orphans.length,
    expired: report.expired.length,
    contradictions: report.contradictions.length,
  };

  await ws.appendEvent(sid, "gc.report", report.summary);
  return report;
}
