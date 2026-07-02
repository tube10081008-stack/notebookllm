// lib/db.js — Firestore CRUD 모듈
import { db } from "./firebase.js";

// ── 스테이션 CRUD ─────────────────────────────────────
export async function loadStations() {
  try {
    const snapshot = await db.collection("stations").orderBy("created_at", "asc").get();
    const stations = [];
    snapshot.forEach(doc => {
      stations.push({ id: doc.id, ...doc.data() });
    });
    return stations;
  } catch (err) {
    console.error("❌ loadStations 오류:", err.message);
    return [];
  }
}

export async function saveStation(station) {
  const { id, ...data } = station;
  await db.collection("stations").doc(id).set(data, { merge: true });
}

export async function deleteStation(id) {
  // 1) 스테이션 기본 문서 삭제
  await db.collection("stations").doc(id).delete();
  // ⚠️ 서브컬렉션들은 Firestore의 동작 구조상 문서가 삭제되어도 남게 되며,
  // 쿼리에 방해되지 않으므로 서비스 수준에서는 즉각 삭제로 간주됩니다.
}

// ── 노트 CRUD ────────────────────────────────────────
export async function loadNote(sid, nid) {
  const doc = await db.collection("stations").doc(sid).collection("notes").doc(nid).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

export async function saveNote(sid, note) {
  const { id, ...data } = note;
  await db.collection("stations").doc(sid).collection("notes").doc(id).set(data, { merge: true });
}

export async function deleteNote(sid, nid) {
  await db.collection("stations").doc(sid).collection("notes").doc(nid).delete();
}

export async function loadAllNotes(sid) {
  try {
    const snapshot = await db.collection("stations").doc(sid).collection("notes").get();
    const notes = [];
    snapshot.forEach(doc => {
      notes.push({ id: doc.id, ...doc.data() });
    });
    return notes;
  } catch {
    return [];
  }
}

// ── 원문(Raw) 보관 ─────────────────────────────────────
export async function saveRawSource(sid, filename, data) {
  await db.collection("stations").doc(sid).collection("raw").doc(filename).set(data);
}

// ── 벡터(Vectors) 관리 ──────────────────────────────────
export async function loadVectors(sid) {
  try {
    const snapshot = await db.collection("stations").doc(sid).collection("vectors").get();
    const vectors = {};
    snapshot.forEach(doc => {
      vectors[doc.id] = doc.data();
    });
    return vectors;
  } catch {
    return {};
  }
}

export async function saveVector(sid, nid, embedding, metadata) {
  await db.collection("stations").doc(sid).collection("vectors").doc(nid).set({ embedding, metadata });
}

export async function deleteVector(sid, nid) {
  await db.collection("stations").doc(sid).collection("vectors").doc(nid).delete();
}

// ── 지식 그래프(Graph) 관리 ─────────────────────────────
export async function loadGraph(sid) {
  try {
    const doc = await db.collection("stations").doc(sid).collection("metadata").doc("graph").get();
    return doc.exists ? doc.data() : { nodes: {}, edges: [] };
  } catch {
    return { nodes: {}, edges: [] };
  }
}

export async function saveGraph(sid, graphData) {
  await db.collection("stations").doc(sid).collection("metadata").doc("graph").set(graphData);
}

// ── 토픽 분류 체계(Taxonomy) 관리 ────────────────────────
export async function loadTaxonomy(sid) {
  try {
    const doc = await db.collection("stations").doc(sid).collection("metadata").doc("taxonomy").get();
    return doc.exists ? doc.data() : { topics: {}, updated_at: null };
  } catch {
    return { topics: {}, updated_at: null };
  }
}

export async function saveTaxonomy(sid, taxonomyData) {
  await db.collection("stations").doc(sid).collection("metadata").doc("taxonomy").set(taxonomyData);
}

// ── 대화록(Chats) 관리 ──────────────────────────────────
export async function loadChats(sid) {
  try {
    const snapshot = await db.collection("stations").doc(sid).collection("chats").orderBy("timestamp", "asc").get();
    const chats = [];
    snapshot.forEach(doc => {
      chats.push(doc.data());
    });
    return chats;
  } catch {
    return [];
  }
}

export async function saveChatSession(sid, chatSession) {
  await db.collection("stations").doc(sid).collection("chats").add(chatSession);
}
