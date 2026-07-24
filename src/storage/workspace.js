// src/storage/workspace.js — 지식 워크스페이스 저장소 (단일 storage 인터페이스)
//
// v1 문제 ③(Firestore/로컬 이원화)의 답: 모든 코어 모듈은 이 모듈만 사용한다.
// 다른 백엔드가 필요해지면 같은 함수 시그니처의 어댑터를 추가한다 — 코어는 무수정.
//
// canonical:  stations.json, raw/, notes/, graph.json, chats.jsonl, events.jsonl
// derived  :  vectors.json (notes에서 재구축 가능 — 불변식 2)
import path from "path";
import { config } from "../config.js";
import * as fsio from "./fsutil.js";
import * as ghio from "./github.js";

// canonical 아티팩트의 저장 백엔드 선택 (filesystem | github).
// 벡터(derived)는 백엔드와 무관하게 항상 로컬 fs에 둔다 — 크고, 재구축 가능하므로
// 커밋 히스토리를 오염시킬 이유가 없다 (하이브리드 영속 모드의 핵심).
const io = config.storageBackend === "github" ? ghio : fsio;
const { ensureDir, exists, atomicWriteJSON, readJSON, appendJSONL, readJSONL, listFiles, removeFile } = io;

const ROOT = config.workspaceRoot;

const p = {
  stations: () => path.join(ROOT, "stations.json"),
  stationDir: (sid) => path.join(ROOT, "stations", sid),
  raw: (sid, name) => path.join(ROOT, "stations", sid, "raw", `${name}.json`),
  rawDir: (sid) => path.join(ROOT, "stations", sid, "raw"),
  note: (sid, nid) => path.join(ROOT, "stations", sid, "notes", `${nid}.json`),
  notesDir: (sid) => path.join(ROOT, "stations", sid, "notes"),
  graph: (sid) => path.join(ROOT, "stations", sid, "graph.json"),
  vectors: (sid) => path.join(ROOT, "stations", sid, "vectors.json"),
  chats: (sid) => path.join(ROOT, "stations", sid, "chats.jsonl"),
  events: (sid) => path.join(ROOT, "stations", sid, "events.jsonl"),
  charter: (sid) => path.join(ROOT, "stations", sid, "charter.json"),
  inbox: (sid) => path.join(ROOT, "stations", sid, "inbox.json"),
  gaps: (sid) => path.join(ROOT, "stations", sid, "gaps.jsonl"),
};

export function workspaceInfo() {
  return {
    root: ROOT,
    backend: config.storageBackend,
    ...(config.storageBackend === "github" ? { repo: config.knowledge.repo, branch: config.knowledge.branch } : {}),
  };
}

// ── 스테이션 (canonical) ──────────────────────────────
export async function loadStations() {
  return (await readJSON(p.stations(), { stations: [] })).stations;
}

export async function saveStations(stations) {
  await atomicWriteJSON(p.stations(), { stations, updated_at: new Date().toISOString() });
}

// ── 원문 Raw (canonical, 불변식 1: 덮어쓰기 거부) ─────
export async function saveRawSource(sid, name, data) {
  const file = p.raw(sid, name);
  if (await exists(file)) {
    throw new Error(`Raw는 불변입니다. 이미 존재하는 원문을 덮어쓸 수 없습니다: ${name}`);
  }
  await atomicWriteJSON(file, data);
  return file;
}

export async function listRawSources(sid) {
  const files = await listFiles(p.rawDir(sid));
  return files.map((f) => f.replace(/\.json$/, ""));
}

export async function loadRawSource(sid, name) {
  return readJSON(p.raw(sid, name));
}

// ── 노트 (canonical) ──────────────────────────────────
export async function saveNote(sid, note) {
  if (!note.id) throw new Error("노트에 stable ID가 없습니다 (불변식 6)");
  await atomicWriteJSON(p.note(sid, note.id), note);
}

export async function loadNote(sid, nid) {
  return readJSON(p.note(sid, nid));
}

export async function deleteNote(sid, nid) {
  return removeFile(p.note(sid, nid));
}

// 여러 노트를 한 번에 저장 — github 백엔드에서는 커밋 1개로 (타임아웃 방지).
export async function saveNotesBatch(sid, notes) {
  if (notes.length === 0) return;
  for (const note of notes) if (!note.id) throw new Error("노트에 stable ID가 없습니다 (불변식 6)");
  if (config.storageBackend === "github") {
    const fileMap = {};
    for (const note of notes) fileMap[p.note(sid, note.id)] = JSON.stringify(note, null, 2);
    await ghio.commitFiles(fileMap, `apply: ${notes.length} notes (station ${sid.slice(0, 8)})`);
  } else {
    for (const note of notes) await fsio.atomicWriteJSON(p.note(sid, note.id), note);
  }
}

// 수집 결과 일괄 커밋: 노트 + 벡터 스냅샷을 같은 커밋에 (M4 — 커밋 수 증가 없음).
// 벡터 스냅샷이 GitHub에 있으면 콜드 스타트가 전량 재임베딩(성장 비례 비용) 대신
// 스냅샷을 읽는다. 스냅샷은 derived — 깨져도 notes에서 재구축 가능 (불변식 2 유지).
export async function saveIngestBatch(sid, notes) {
  if (notes.length === 0) return;
  for (const note of notes) if (!note.id) throw new Error("노트에 stable ID가 없습니다 (불변식 6)");
  if (config.storageBackend === "github") {
    const store = await loadVectors(sid); // 방금 saveVectorsBatch로 갱신된 캐시
    const fileMap = { [p.vectors(sid)]: JSON.stringify(store) };
    for (const note of notes) fileMap[p.note(sid, note.id)] = JSON.stringify(note, null, 2);
    await ghio.commitFiles(fileMap, `apply: ${notes.length} notes + vector snapshot (station ${sid.slice(0, 8)})`);
  } else {
    for (const note of notes) await fsio.atomicWriteJSON(p.note(sid, note.id), note);
  }
}

// 콜드 스타트 수화(hydrate): GitHub의 벡터 스냅샷을 로컬 캐시로 (M4).
// 반환: 스냅샷 store 또는 null(스냅샷 없음). 임베딩 모델이 다르면 무시(안전).
export async function hydrateVectorsFromSnapshot(sid, currentModel) {
  if (config.storageBackend !== "github") return null;
  try {
    const snap = await ghio.readJSON(p.vectors(sid), null);
    if (!snap?.items || !Object.keys(snap.items).length) return null;
    if (snap.model && currentModel && snap.model !== currentModel) return null;
    vectorCache.set(sid, snap);
    await fsio.atomicWriteJSON(p.vectors(sid), snap); // 로컬 /tmp 캐시로도
    return snap;
  } catch (err) {
    console.warn("벡터 스냅샷 수화 실패(재구축으로 폴백):", err.message);
    return null;
  }
}

export async function loadAllNotes(sid) {
  const files = await listFiles(p.notesDir(sid));
  const notes = [];
  for (const f of files) {
    const note = await readJSON(path.join(p.notesDir(sid), f));
    if (note) notes.push(note);
  }
  return notes;
}

// ── 그래프 엣지 (canonical — LLM 제안, 사용자 수정 가능) ─
export async function loadGraph(sid) {
  return readJSON(p.graph(sid), { edges: [] });
}

export async function saveGraph(sid, graph) {
  await atomicWriteJSON(p.graph(sid), graph);
}

// ── 벡터 (derived — model/dims 각인, v1 문제 ⑩의 답) ──
// 파일이 진실, 메모리는 캐시 (v1 문제 ④의 답). 쓰기는 반드시 이 모듈을 거쳐
// 캐시와 파일이 함께 갱신된다.
// ⚠️ 벡터는 백엔드와 무관하게 항상 로컬 fs (github 모드에서는 /tmp 캐시 —
//    콜드 스타트 시 notes에서 자동 재구축된다. retrieve.ensureVectorStore 참조).
const vectorCache = new Map(); // sid → { model, dims, items }

// 소수 5자리 반올림 — 코사인 유사도 영향은 1e-5 수준으로 무시 가능,
// JSON 스냅샷 크기는 ~60% 감소 (GitHub 커밋 동승 비용 절감, M4)
const roundVec = (v) => v.map((x) => Math.round(x * 1e5) / 1e5);

export async function loadVectors(sid) {
  if (vectorCache.has(sid)) return vectorCache.get(sid);
  const store = await fsio.readJSON(p.vectors(sid), { model: null, dims: null, items: {} });
  vectorCache.set(sid, store);
  return store;
}

export async function saveVector(sid, nid, embedding, { model, dims, meta = {} }) {
  const store = await loadVectors(sid);
  if (store.model && store.model !== model) {
    throw new Error(
      `임베딩 모델 불일치: 저장소는 "${store.model}", 현재 provider는 "${model}"입니다. ` +
      `모델을 되돌리거나 \`npm run reindex\`로 전량 재임베딩하세요 (불변식 2).`
    );
  }
  store.model = model;
  store.dims = dims;
  store.items[nid] = { v: roundVec(embedding), ...meta };
  await fsio.atomicWriteJSON(p.vectors(sid), store);
}

export async function deleteVector(sid, nid) {
  const store = await loadVectors(sid);
  delete store.items[nid];
  await fsio.atomicWriteJSON(p.vectors(sid), store);
}

// 여러 벡터를 한 번에 (로컬 파일 1회 쓰기 — N번 재쓰기 방지)
export async function saveVectorsBatch(sid, entries, { model, dims }) {
  if (entries.length === 0) return;
  const store = await loadVectors(sid);
  if (store.model && store.model !== model) {
    throw new Error(`임베딩 모델 불일치: 저장소 "${store.model}" vs 현재 "${model}". \`npm run reindex\` 필요.`);
  }
  store.model = model;
  store.dims = dims;
  for (const { nid, embedding, meta } of entries) store.items[nid] = { v: roundVec(embedding), ...meta };
  await fsio.atomicWriteJSON(p.vectors(sid), store);
}

export async function replaceVectorStore(sid, newStore) {
  for (const item of Object.values(newStore.items || {})) {
    if (Array.isArray(item.v)) item.v = roundVec(item.v);
  }
  vectorCache.set(sid, newStore);
  await fsio.atomicWriteJSON(p.vectors(sid), newStore);
  // 재구축(reindex·콜드스타트 보완분)도 스냅샷으로 영속화 (M4)
  if (config.storageBackend === "github") {
    try {
      await ghio.commitFiles({ [p.vectors(sid)]: JSON.stringify(newStore) }, `vectors: snapshot (station ${sid.slice(0, 8)})`);
    } catch (err) {
      console.warn("벡터 스냅샷 커밋 실패(다음 수집 때 갱신):", err.message);
    }
  }
}

export function invalidateVectorCache(sid = null) {
  if (sid) vectorCache.delete(sid);
  else vectorCache.clear();
}

// ── 대화 (append-only) ────────────────────────────────
export async function appendChat(sid, chat) {
  await appendJSONL(p.chats(sid), chat);
}

export async function loadChats(sid, limit = 0) {
  const chats = await readJSONL(p.chats(sid));
  return limit > 0 ? chats.slice(-limit) : chats;
}

// ── 이벤트 감사 로그 (append-only, 불변식 3) ──────────
export async function appendEvent(sid, type, payload = {}) {
  await appendJSONL(p.events(sid), { ts: new Date().toISOString(), type, ...payload });
}

// 여러 이벤트를 한 번의 append로 (github 백엔드: 커밋 1회)
export async function appendEvents(sid, events) {
  if (!events.length) return;
  await appendJSONL(p.events(sid), events);
}

export async function loadEvents(sid, limit = 100) {
  const events = await readJSONL(p.events(sid));
  return events.slice(-limit);
}

// ── 지식 헌장 Charter (canonical — 스테이션의 수집·학습 방향) ──
export async function loadCharter(sid) {
  return readJSON(p.charter(sid), null);
}

export async function saveCharter(sid, charter) {
  charter.updated_at = new Date().toISOString();
  await atomicWriteJSON(p.charter(sid), charter);
}

// ── 수집함 Inbox (canonical — 스카우트 제안, 인간이 처분) ──
export async function loadInbox(sid) {
  return readJSON(p.inbox(sid), { items: [] });
}

export async function saveInbox(sid, inbox) {
  await atomicWriteJSON(p.inbox(sid), inbox);
}

// ── 지식 결핍 신호 Gaps (append-only — 답변이 드러낸 부족 영역) ──
export async function appendGaps(sid, gaps, question) {
  const ts = new Date().toISOString();
  const rows = gaps.map((gap) => ({ ts, gap, question: (question || "").slice(0, 120) }));
  await appendJSONL(p.gaps(sid), rows); // 한 번의 append (github 모드에서 커밋 1회)
}

export async function loadRecentGaps(sid, limit = 20) {
  const rows = await readJSONL(p.gaps(sid));
  const seen = new Set();
  const unique = [];
  for (const row of rows.reverse()) {
    const key = row.gap?.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
    if (unique.length >= limit) break;
  }
  return unique;
}

// ── 복구 지원 ─────────────────────────────────────────
export async function listStationDirs() {
  return io.listDirs(path.join(ROOT, "stations"));
}

// stations.json의 과거 버전들에서 스테이션 항목을 수집한다 (github 백엔드 전용).
// 최신 커밋부터 거슬러 올라가며, 각 id의 가장 최근 모습을 채택한다.
export async function loadStationsFromHistory(limit = 20) {
  if (config.storageBackend !== "github") return new Map();
  const byId = new Map();
  try {
    const versions = await ghio.listFileVersions(p.stations(), limit);
    for (const sha of versions) {
      const snapshot = await ghio.readJSONAtVersion(p.stations(), sha);
      for (const station of snapshot?.stations || []) {
        if (station?.id && !byId.has(station.id)) byId.set(station.id, station);
      }
    }
  } catch (err) {
    console.warn("히스토리 조회 실패:", err.message);
  }
  return byId;
}

// ── 스테이션 디렉토리 초기화/삭제 ─────────────────────
export async function initStationDirs(sid) {
  await ensureDir(p.rawDir(sid));
  await ensureDir(p.notesDir(sid));
}

export async function stationDataPath(sid) {
  return p.stationDir(sid);
}
