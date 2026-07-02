// lib/graph.js — 인메모리 지식 그래프 (JSON 기반)
import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";

const GRAPH_PATH = "data/graph.json";

// ── 유효한 관계 타입 ─────────────────────────────────
const VALID_RELATIONS = [
  "supports",
  "contradicts",
  "applies_to",
  "derived_from",
  "obsoletes",
  "related_to",
  "same_agent",
];

// ── 내부 상태 ────────────────────────────────────────
let graph = { nodes: {}, edges: [] };
let initialized = false;

// ── 초기화 ───────────────────────────────────────────
export async function init() {
  if (initialized) return;

  try {
    const raw = await readFile(GRAPH_PATH, "utf-8");
    graph = JSON.parse(raw);
    // edges 배열이 없으면 빈 배열로 초기화
    if (!graph.edges) graph.edges = [];
    if (!graph.nodes) graph.nodes = {};
    console.log(
      `🕸️ 그래프 로드 완료: 노드 ${Object.keys(graph.nodes).length}개, ` +
        `엣지 ${graph.edges.length}개`,
    );
  } catch {
    graph = { nodes: {}, edges: [] };
    console.log("🕸️ 그래프 새로 생성");
  }
  initialized = true;
}

// ── 노드 추가 ────────────────────────────────────────
export function addNode(note) {
  graph.nodes[note.id] = {
    id: note.id,
    title: note.title,
    type: note.type || "fact",
    topics: note.topics || [],
    half_life: note.half_life || "permanent",
    confidence: note.confidence ?? 0.8,
    created_at: note.created_at || new Date().toISOString(),
    last_accessed: note.last_accessed || new Date().toISOString(),
    access_count: note.access_count || 0,
    archived: note.archived || false,
    source: note.source || {},
  };
}

// ── 노드 가져오기 ────────────────────────────────────
export function getNode(id) {
  return graph.nodes[id] || null;
}

// ── 모든 노드 ────────────────────────────────────────
export function getAllNodes() {
  return Object.values(graph.nodes);
}

// ── 노드 업데이트 ────────────────────────────────────
export function updateNode(id, updates) {
  if (!graph.nodes[id]) return null;
  Object.assign(graph.nodes[id], updates);
  return graph.nodes[id];
}

// ── 엣지 추가 ────────────────────────────────────────
export function addEdge(source, target, relation, weight = 1.0) {
  if (!VALID_RELATIONS.includes(relation)) {
    relation = "related_to";
  }

  // 중복 엣지 방지
  const exists = graph.edges.some(
    (e) =>
      e.source === source && e.target === target && e.relation === relation,
  );
  if (exists) return;

  graph.edges.push({ source, target, relation, weight });
}

// ── 노드 제거 (연결된 엣지도 함께) ──────────────────
export function removeNode(id) {
  delete graph.nodes[id];
  graph.edges = graph.edges.filter(
    (e) => e.source !== id && e.target !== id,
  );
}

// ── BFS 탐색 (depth 제한) ────────────────────────────
export function findRelated(nodeId, depth = 2) {
  const visited = new Set();
  const result = [];
  let frontier = [nodeId];

  for (let d = 0; d < depth; d++) {
    const nextFrontier = [];

    for (const nid of frontier) {
      if (visited.has(nid)) continue;
      visited.add(nid);

      const neighbors = getNeighborEdges(nid);
      for (const edge of neighbors) {
        const otherId = edge.source === nid ? edge.target : edge.source;
        if (!visited.has(otherId) && graph.nodes[otherId]) {
          result.push({
            node: graph.nodes[otherId],
            relation: edge.relation,
            weight: edge.weight,
            depth: d + 1,
          });
          nextFrontier.push(otherId);
        }
      }
    }
    frontier = nextFrontier;
  }

  return result;
}

// ── 직접 이웃 노드 ──────────────────────────────────
export function getNeighbors(nodeId) {
  const edges = getNeighborEdges(nodeId);
  return edges
    .map((e) => {
      const otherId = e.source === nodeId ? e.target : e.source;
      return graph.nodes[otherId]
        ? { node: graph.nodes[otherId], relation: e.relation, weight: e.weight }
        : null;
    })
    .filter(Boolean);
}

function getNeighborEdges(nodeId) {
  return graph.edges.filter(
    (e) => e.source === nodeId || e.target === nodeId,
  );
}

// ── 고아 노드 (연결 0개) ─────────────────────────────
export function findOrphans() {
  const connectedIds = new Set();
  for (const e of graph.edges) {
    connectedIds.add(e.source);
    connectedIds.add(e.target);
  }

  return Object.values(graph.nodes).filter(
    (n) => !connectedIds.has(n.id) && !n.archived,
  );
}

// ── 모순 관계 노드 쌍 ────────────────────────────────
export function findContradictions() {
  return graph.edges
    .filter((e) => e.relation === "contradicts")
    .map((e) => ({
      nodeA: graph.nodes[e.source],
      nodeB: graph.nodes[e.target],
      weight: e.weight,
    }))
    .filter((pair) => pair.nodeA && pair.nodeB);
}

// ── 통계 ─────────────────────────────────────────────
export function getStats() {
  const nodeCount = Object.keys(graph.nodes).length;
  const edgeCount = graph.edges.length;
  const orphans = findOrphans();
  const avgConnections = nodeCount > 0 ? (edgeCount * 2) / nodeCount : 0;
  const archivedCount = Object.values(graph.nodes).filter(
    (n) => n.archived,
  ).length;

  // 타입별 통계
  const typeStats = {};
  for (const n of Object.values(graph.nodes)) {
    typeStats[n.type] = (typeStats[n.type] || 0) + 1;
  }

  return {
    nodeCount,
    edgeCount,
    orphanCount: orphans.length,
    archivedCount,
    avgConnections: Math.round(avgConnections * 100) / 100,
    typeStats,
  };
}

// ── 저장 ─────────────────────────────────────────────
export async function save() {
  try {
    await mkdir(dirname(GRAPH_PATH), { recursive: true });
    await writeFile(GRAPH_PATH, JSON.stringify(graph, null, 2), "utf-8");
  } catch (err) {
    console.error("❌ 그래프 저장 실패:", err.message);
  }
}

// ── 원본 그래프 데이터 (시각화용) ────────────────────
export function getRawGraph() {
  return {
    nodes: Object.values(graph.nodes),
    edges: graph.edges,
  };
}

export { VALID_RELATIONS };
