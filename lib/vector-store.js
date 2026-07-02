// lib/vector-store.js — 인메모리 벡터 저장소 (cosine similarity 검색)
import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";

const STORE_PATH = "data/vectors.json";

// ── 내부 상태 ────────────────────────────────────────
let vectors = {}; // { id: { embedding: number[], metadata?: any } }
let initialized = false;
let saveTimer = null;

// ── 초기화 ───────────────────────────────────────────
export async function init() {
  if (initialized) return;

  try {
    const raw = await readFile(STORE_PATH, "utf-8");
    vectors = JSON.parse(raw);
    console.log(`📦 벡터 저장소 로드 완료: ${Object.keys(vectors).length}개`);
  } catch {
    vectors = {};
    console.log("📦 벡터 저장소 새로 생성");
  }
  initialized = true;
}

// ── 벡터 추가 ────────────────────────────────────────
export async function addVector(id, embedding, metadata = {}) {
  vectors[id] = { embedding, metadata };
  debouncedSave();
}

// ── 벡터 제거 ────────────────────────────────────────
export async function removeVector(id) {
  delete vectors[id];
  debouncedSave();
}

// ── 유사도 검색 ──────────────────────────────────────
export function search(queryEmbedding, topK = 10) {
  const results = [];

  for (const [id, entry] of Object.entries(vectors)) {
    const score = cosineSimilarity(queryEmbedding, entry.embedding);
    results.push({ id, score });
  }

  // 점수 높은 순 정렬 → 상위 topK개 반환
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

// ── 전체 조회 ────────────────────────────────────────
export function getAll() {
  return vectors;
}

// ── 개수 ─────────────────────────────────────────────
export function count() {
  return Object.keys(vectors).length;
}

// ── 저장 (디바운싱 적용) ────────────────────────────
function debouncedSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(), 500);
}

export async function save() {
  try {
    await mkdir(dirname(STORE_PATH), { recursive: true });
    await writeFile(STORE_PATH, JSON.stringify(vectors), "utf-8");
  } catch (err) {
    console.error("❌ 벡터 저장소 저장 실패:", err.message);
  }
}

// ── Cosine Similarity ────────────────────────────────
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export { cosineSimilarity };
