// src/storage/workspace.js — 지식 워크스페이스 저장소 (단일 storage 인터페이스)
//
// v1 문제 ③(Firestore/로컬 이원화)의 답: 모든 코어 모듈은 이 모듈만 사용한다.
// 다른 백엔드가 필요해지면 같은 함수 시그니처의 어댑터를 추가한다 — 코어는 무수정.
//
// canonical:  stations.json, raw/, notes/, graph.json, chats.jsonl, events.jsonl
// derived  :  vectors.json (notes에서 재구축 가능 — 불변식 2)
import path from "path";
import { config } from "../config.js";
import {
  ensureDir, exists, atomicWriteJSON, readJSON,
  appendJSONL, readJSONL, listFiles, removeFile,
} from "./fsutil.js";

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
};

export function workspaceInfo() {
  return { root: ROOT };
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
// 캐시와 파일이 함께 갱신된다. 단일 프로세스 로컬 서버 전제 (ARCHITECTURE §1-⑤).
const vectorCache = new Map(); // sid → { model, dims, items }

export async function loadVectors(sid) {
  if (vectorCache.has(sid)) return vectorCache.get(sid);
  const store = await readJSON(p.vectors(sid), { model: null, dims: null, items: {} });
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
  store.items[nid] = { v: embedding, ...meta };
  await atomicWriteJSON(p.vectors(sid), store);
}

export async function deleteVector(sid, nid) {
  const store = await loadVectors(sid);
  delete store.items[nid];
  await atomicWriteJSON(p.vectors(sid), store);
}

export async function replaceVectorStore(sid, newStore) {
  vectorCache.set(sid, newStore);
  await atomicWriteJSON(p.vectors(sid), newStore);
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

export async function loadEvents(sid, limit = 100) {
  const events = await readJSONL(p.events(sid));
  return events.slice(-limit);
}

// ── 스테이션 디렉토리 초기화/삭제 ─────────────────────
export async function initStationDirs(sid) {
  await ensureDir(p.rawDir(sid));
  await ensureDir(p.notesDir(sid));
}

export async function stationDataPath(sid) {
  return p.stationDir(sid);
}
