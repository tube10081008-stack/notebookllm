// src/core/stations.js — 스테이션 CRUD (storage 인터페이스 위에서만 동작)
import crypto from "crypto";
import * as ws from "../storage/workspace.js";
import { AGENT_PRESETS, levelForXP } from "./personas.js";
import { config } from "../config.js";

// 스테이션 수는 적으므로 항상 파일에서 읽는다 — 인메모리 진실 금지 (v1 문제 ⑤).
export async function getAll() {
  return ws.loadStations();
}

export async function getById(id) {
  const stations = await ws.loadStations();
  return stations.find((s) => s.id === id) || null;
}

export async function createStation({ name, description, icon, presetKey, customAgent }) {
  if (!name || !String(name).trim()) throw new Error("스테이션 이름이 필요합니다.");
  const preset = AGENT_PRESETS[presetKey] || AGENT_PRESETS.researcher;
  const agent = customAgent ? { ...preset, ...customAgent } : { ...preset };
  const id = crypto.randomUUID();

  const station = {
    id,
    name: String(name).trim(),
    description: description || "",
    icon: icon || agent.avatar || "🧠",
    color: agent.color || "#7C3AED",
    created_at: new Date().toISOString(),
    agent: {
      name: agent.name, avatar: agent.avatar,
      personality: agent.personality, tone: agent.tone,
      expertise: agent.expertise, greeting: agent.greeting,
      system_prompt: agent.system_prompt,
      synthesized: !!agent.synthesized,           // 헌장에서 합성된 에이전트인지
      ...(agent.synthesized_at ? { synthesized_at: agent.synthesized_at } : {}),
    },
    stats: { source_count: 0, note_count: 0, query_count: 0, xp: 0 },
  };

  const stations = await ws.loadStations();
  stations.push(station);
  await ws.saveStations(stations);
  await ws.initStationDirs(id);
  await ws.appendEvent(id, "station.created", { name: station.name, preset: presetKey });
  return station;
}

export async function updateStation(id, updates) {
  const stations = await ws.loadStations();
  const station = stations.find((s) => s.id === id);
  if (!station) return null;

  for (const key of ["name", "description", "icon", "color"]) {
    if (updates[key] !== undefined) station[key] = updates[key];
  }
  if (updates.agent) Object.assign(station.agent, updates.agent);

  await ws.saveStations(stations);
  await ws.appendEvent(id, "station.updated", { fields: Object.keys(updates) });
  return station;
}

// 목록에서만 제거한다. 지식 디렉토리는 파괴하지 않는다 (불변식 5 — 삭제는 인간의 결정).
export async function deleteStation(id) {
  const stations = await ws.loadStations();
  const idx = stations.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  const [removed] = stations.splice(idx, 1);
  await ws.saveStations(stations);
  await ws.appendEvent(id, "station.detached", {
    name: removed.name,
    note: "스테이션이 목록에서 제거되었습니다. 데이터 디렉토리는 보존됩니다.",
  });
  return true;
}

// 통계 갱신 — best-effort 텔레메트리 (실패가 본 작업을 막아서는 안 된다)
// github 백엔드에서는 가장 중요한 파일(stations.json 명부)에 대한 쓰기 경합을
// 최소화하기 위해, 실질 지표(note_count/source_count)만 영속화한다.
// query_count·xp는 표시용 — 명부 소실 사고의 재발 방지가 카운터보다 중요하다.
export async function bumpStats(id, delta = {}) {
  try {
    const stations = await ws.loadStations();
    const station = stations.find((s) => s.id === id);
    if (!station) return null;
    for (const [k, v] of Object.entries(delta)) {
      station.stats[k] = (station.stats[k] || 0) + v;
    }
    const meaningful = delta.note_count !== undefined || delta.source_count !== undefined;
    if (config.storageBackend !== "github" || meaningful) {
      await ws.saveStations(stations);
    }
    return station;
  } catch (err) {
    console.warn("통계 갱신 실패(무시):", err.message);
    return null;
  }
}

// ── 명부 복구 (비상 도구) ─────────────────────────────
// stations.json이 훼손·소실됐을 때: ① git 히스토리에서 원형 그대로(이름·에이전트·통계),
// ② 히스토리에도 없으면 디렉토리+헌장에서 최소 복원.
// 주의: 의도적으로 '분리'했던 스테이션도 부활할 수 있다 — 복구 후 다시 분리하면 된다.
export async function repairStations(synthesizeAgentFn = null) {
  const current = await ws.loadStations();
  const known = new Set(current.map((s) => s.id));
  const recovered = [];

  // ① git 히스토리 (github 백엔드): 원형 보존 복구
  const historical = await ws.loadStationsFromHistory();
  for (const [id, station] of historical) {
    if (known.has(id)) continue;
    current.push(station);
    known.add(id);
    recovered.push({ id, name: station.name, via: "history" });
  }

  // ② 디렉토리 스캔: 어느 명부에도 없는 지식 디렉토리 → 헌장 기반 최소 복원
  const dirs = await ws.listStationDirs();
  for (const id of dirs) {
    if (known.has(id)) continue;
    const charter = await ws.loadCharter(id);
    let agent = { ...AGENT_PRESETS.researcher, synthesized: false };
    if (charter && synthesizeAgentFn) {
      try {
        const a = await synthesizeAgentFn(charter);
        if (a.synthesized) agent = a;
      } catch { /* 프리셋 폴백 */ }
    }
    const notes = await ws.loadAllNotes(id);
    const station = {
      id,
      name: (charter?.purpose || "").slice(0, 24) || `복구된 스테이션 (${id.slice(0, 8)})`,
      description: charter?.purpose || "",
      icon: agent.avatar || "🧠",
      color: agent.color || "#7C3AED",
      created_at: new Date().toISOString(),
      agent: {
        name: agent.name, avatar: agent.avatar,
        personality: agent.personality, tone: agent.tone,
        expertise: agent.expertise, greeting: agent.greeting,
        system_prompt: agent.system_prompt,
        synthesized: !!agent.synthesized,
      },
      stats: { source_count: 0, note_count: notes.length, query_count: 0, xp: 0 },
    };
    current.push(station);
    known.add(id);
    recovered.push({ id, name: station.name, via: "directory" });
  }

  if (recovered.length > 0) {
    await ws.saveStations(current);
    for (const r of recovered) {
      await ws.appendEvent(r.id, "station.recovered", { via: r.via, name: r.name });
    }
  }
  return { recovered, total: current.length };
}

export function gamificationView(station) {
  const xp = station.stats?.xp || 0;
  const level = levelForXP(xp);
  return { xp, level: level.level, title: level.title, badge: level.badge };
}

// XP 부여 규칙 (v1 게이미피케이션의 경량 버전 — ARCHITECTURE §8)
export const XP_RULES = {
  source_added: 20,
  note_created: 5,
  query_asked: 2,
  my_take_written: 15,
};

export async function grantXP(id, action) {
  const gain = XP_RULES[action] || 0;
  if (!gain) return null;
  const station = await bumpStats(id, { xp: gain });
  if (!station) return null;
  const view = gamificationView(station);
  return { xpGain: gain, totalXP: view.xp, level: view.level, title: view.title };
}
