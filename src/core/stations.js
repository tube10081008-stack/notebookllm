// src/core/stations.js — 스테이션 CRUD (storage 인터페이스 위에서만 동작)
import crypto from "crypto";
import * as ws from "../storage/workspace.js";
import { AGENT_PRESETS, levelForXP } from "./personas.js";

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

// 통계 갱신: 파일에서 읽고-수정-쓰기 (단일 프로세스 전제)
export async function bumpStats(id, delta = {}) {
  const stations = await ws.loadStations();
  const station = stations.find((s) => s.id === id);
  if (!station) return null;
  for (const [k, v] of Object.entries(delta)) {
    station.stats[k] = (station.stats[k] || 0) + v;
  }
  await ws.saveStations(stations);
  return station;
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
