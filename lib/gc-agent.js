// lib/gc-agent.js — 지식 베이스 가비지 컬렉션 에이전트
import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import * as vectorStore from "./vector-store.js";
import * as graph from "./graph.js";
import { embedText, generateText } from "./gemini.js";
import { cosineSimilarity } from "./vector-store.js";

const GC_REPORTS_DIR = "data/gc-reports";

// ── GC 실행 (전체 5단계) ─────────────────────────────
export async function runGC() {
  console.log("🧹 GC 시작...");
  const startTime = Date.now();

  // 저장소 초기화 확인
  await vectorStore.init();
  await graph.init();

  const report = {
    timestamp: new Date().toISOString(),
    steps: {},
    summary: {},
  };

  // Step 1: 중복 감지
  console.log("  [1/5] 중복 감지...");
  report.steps.duplicates = await detectDuplicates();

  // Step 2: 고아 노드 감지
  console.log("  [2/5] 고아 노드 감지...");
  report.steps.orphans = await detectOrphans();

  // Step 3: 모순 감지
  console.log("  [3/5] 모순 감지...");
  report.steps.contradictions = detectContradictions();

  // Step 4: Decay 패스
  console.log("  [4/5] Decay 패스...");
  report.steps.decay = await runDecayPass();

  // Step 5: 통계
  console.log("  [5/5] 통계 수집...");
  report.steps.stats = graph.getStats();

  // 요약
  const elapsed = Date.now() - startTime;
  report.summary = {
    elapsed_ms: elapsed,
    duplicateCandidates: report.steps.duplicates.length,
    orphansFound: report.steps.orphans.total,
    orphansAutoLinked: report.steps.orphans.autoLinked,
    contradictionPairs: report.steps.contradictions.length,
    nodesArchived: report.steps.decay.archived,
    totalNodes: report.steps.stats.nodeCount,
    totalEdges: report.steps.stats.edgeCount,
  };

  // 리포트 저장
  await saveReport(report);
  await graph.save();
  await vectorStore.save();

  console.log(
    `🧹 GC 완료 (${elapsed}ms):\n` +
      `   중복 후보: ${report.summary.duplicateCandidates}개\n` +
      `   고아 노드: ${report.summary.orphansFound}개 (자동 링크: ${report.summary.orphansAutoLinked}개)\n` +
      `   모순 쌍: ${report.summary.contradictionPairs}개\n` +
      `   아카이브: ${report.summary.nodesArchived}개`,
  );

  return report;
}

// ── Step 1: 중복 감지 ────────────────────────────────
async function detectDuplicates() {
  const allVectors = vectorStore.getAll();
  const ids = Object.keys(allVectors);
  const candidates = [];
  const checked = new Set();

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const key = `${ids[i]}:${ids[j]}`;
      if (checked.has(key)) continue;
      checked.add(key);

      const similarity = cosineSimilarity(
        allVectors[ids[i]].embedding,
        allVectors[ids[j]].embedding,
      );

      if (similarity > 0.9) {
        const nodeA = graph.getNode(ids[i]);
        const nodeB = graph.getNode(ids[j]);
        candidates.push({
          noteA: {
            id: ids[i],
            title: nodeA?.title || ids[i],
          },
          noteB: {
            id: ids[j],
            title: nodeB?.title || ids[j],
          },
          similarity: Math.round(similarity * 1000) / 1000,
        });
      }
    }
  }

  return candidates;
}

// ── Step 2: 고아 노드 감지 + 자동 링크 시도 ──────────
async function detectOrphans() {
  const orphans = graph.findOrphans();
  let autoLinked = 0;
  const quarantined = [];

  for (const orphan of orphans) {
    // 벡터 유사도로 연결 시도
    const allVectors = vectorStore.getAll();
    const orphanVector = allVectors[orphan.id]?.embedding;

    if (!orphanVector) {
      quarantined.push({ id: orphan.id, title: orphan.title });
      continue;
    }

    const similar = vectorStore.search(orphanVector, 5);
    const bestMatch = similar.find(
      (s) => s.id !== orphan.id && s.score > 0.6,
    );

    if (bestMatch) {
      graph.addEdge(orphan.id, bestMatch.id, "related_to", bestMatch.score);
      autoLinked++;
    } else {
      quarantined.push({ id: orphan.id, title: orphan.title });
    }
  }

  return {
    total: orphans.length,
    autoLinked,
    quarantined,
  };
}

// ── Step 3: 모순 감지 ────────────────────────────────
function detectContradictions() {
  return graph.findContradictions().map((c) => ({
    noteA: { id: c.nodeA.id, title: c.nodeA.title, type: c.nodeA.type },
    noteB: { id: c.nodeB.id, title: c.nodeB.title, type: c.nodeB.type },
    weight: c.weight,
  }));
}

// ── Step 4: Decay 패스 ───────────────────────────────
async function runDecayPass() {
  const now = Date.now();
  const allNodes = graph.getAllNodes();
  let archived = 0;
  const archivedNotes = [];

  // half_life를 밀리초로 변환
  const halfLifeMs = {
    "6mo": 180 * 24 * 60 * 60 * 1000,
    "1yr": 365 * 24 * 60 * 60 * 1000,
    "5yr": 5 * 365 * 24 * 60 * 60 * 1000,
  };

  for (const node of allNodes) {
    if (node.archived || node.half_life === "permanent") continue;

    const hlMs = halfLifeMs[node.half_life];
    if (!hlMs) continue;

    // 마지막 접근 이후 경과 시간으로 판단
    const lastAccessed = new Date(
      node.last_accessed || node.created_at,
    ).getTime();
    const elapsed = now - lastAccessed;

    // half_life * 3 이상 경과하면 아카이브 (사실상 거의 0으로 감소)
    if (elapsed > hlMs * 3) {
      graph.updateNode(node.id, { archived: true });
      archived++;
      archivedNotes.push({ id: node.id, title: node.title });
    }
  }

  return { archived, archivedNotes };
}

// ── 리포트 저장 ──────────────────────────────────────
async function saveReport(report) {
  try {
    await mkdir(GC_REPORTS_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const filename = `${GC_REPORTS_DIR}/gc-${date}.json`;
    await writeFile(filename, JSON.stringify(report, null, 2), "utf-8");
    console.log(`📄 GC 리포트 저장: ${filename}`);
  } catch (err) {
    console.error("❌ GC 리포트 저장 실패:", err.message);
  }
}

// ── 리포트 목록 ──────────────────────────────────────
export async function listReports() {
  try {
    await mkdir(GC_REPORTS_DIR, { recursive: true });
    const files = await readdir(GC_REPORTS_DIR);
    return files
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

// ── 리포트 읽기 ──────────────────────────────────────
export async function getReport(filename) {
  try {
    const raw = await readFile(
      `${GC_REPORTS_DIR}/${filename}`,
      "utf-8",
    );
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
