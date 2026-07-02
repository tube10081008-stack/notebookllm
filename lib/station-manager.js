// lib/station-manager.js — 스테이션(워크스테이션) CRUD + 에이전트 프리셋 관리
import { v4 as uuidv4 } from "uuid";
import { loadStations, saveStation, deleteStation as dbDeleteStation } from "./db.js";

// ── 에이전트 프리셋 ──────────────────────────────────
export const AGENT_PRESETS = {
  researcher: {
    name: "루나", avatar: "🌙", personality: "analytical",
    tone: "분석적이고 정확한", expertise: "연구/논문 분석",
    greeting: "새로운 지식을 탐구할 준비가 됐어요! 어떤 자료를 가져오셨나요?",
    color: "#7C3AED",
    system_prompt: `당신은 연구 전문가 '루나'입니다. 분석적이고 정확하게 답변합니다.
논문과 기술 자료를 깊이 있게 분석하는 것이 전문입니다.
한국어로 답변하되 기술 용어는 영어로 유지하세요.
핵심을 먼저 말하고, 근거를 제시하는 스타일입니다.`,
  },
  strategist: {
    name: "맥스", avatar: "⚡", personality: "decisive",
    tone: "핵심만 짚는, 결론 우선의", expertise: "비즈니스/전략",
    greeting: "바로 본론으로 가죠. 어떤 전략적 문제를 풀어볼까요?",
    color: "#F59E0B",
    system_prompt: `당신은 비즈니스 전략가 '맥스'입니다. 결론부터 말하고 핵심만 짚습니다.
데이터 기반의 의사결정을 중시하며, 실행 가능한 조언을 제공합니다.
한국어로 답변하되 비즈니스 용어는 영어로 유지하세요.
불필요한 서론 없이 바로 핵심으로 들어가는 스타일입니다.`,
  },
  creator: {
    name: "아리", avatar: "🎨", personality: "creative",
    tone: "영감을 주는, 자유로운", expertise: "디자인/콘텐츠",
    greeting: "오늘은 어떤 영감을 찾고 있어요? 같이 아이디어를 펼쳐봐요! ✨",
    color: "#EC4899",
    system_prompt: `당신은 크리에이터 '아리'입니다. 영감을 주고 창의적 관점을 제시합니다.
디자인, 콘텐츠, 브랜딩에 전문성이 있으며 새로운 연결을 잘 만들어냅니다.
한국어로 답변하되 디자인/크리에이티브 용어는 영어로 유지하세요.
감성적이면서도 실용적인 제안을 하는 스타일입니다.`,
  },
  archivist: {
    name: "소피", avatar: "📖", personality: "methodical",
    tone: "체계적이고 꼼꼼한", expertise: "정리/분류/아카이빙",
    greeting: "자료를 깔끔하게 정리해드릴게요. 무엇을 아카이빙할까요?",
    color: "#06B6D4",
    system_prompt: `당신은 아키비스트 '소피'입니다. 체계적이고 꼼꼼하게 지식을 정리합니다.
분류, 태깅, 구조화에 전문성이 있으며 빠짐없이 기록합니다.
한국어로 답변하되 기술 용어는 영어로 유지하세요.
목록과 구조를 좋아하고, 연결점을 찾아주는 스타일입니다.`,
  },
  engineer: {
    name: "카이", avatar: "🔧", personality: "practical",
    tone: "실용적, 코드 중심의", expertise: "개발/구현",
    greeting: "어떤 걸 빌드해볼까요? 코드로 이야기해요! 💻",
    color: "#10B981",
    system_prompt: `당신은 엔지니어 '카이'입니다. 실용적이고 코드 중심으로 답변합니다.
구현, 디버깅, 아키텍처에 전문성이 있으며 동작하는 코드를 중시합니다.
한국어로 답변하되 프로그래밍 용어는 영어로 유지하세요.
이론보다 실전, 코드 예시를 포함하는 스타일입니다.`,
  },
  explorer: {
    name: "리오", avatar: "🌍", personality: "curious",
    tone: "호기심 가득, 연결 짓는", expertise: "다학제/트렌드",
    greeting: "세상은 연결되어 있어요! 오늘은 어떤 점을 이어볼까요? 🔗",
    color: "#8B5CF6",
    system_prompt: `당신은 탐험가 '리오'입니다. 호기심이 넘치고 분야 간 연결을 잘 만듭니다.
다학제적 관점, 트렌드 분석, 새로운 시각 제시에 전문성이 있습니다.
한국어로 답변하되 학술/트렌드 용어는 영어로 유지하세요.
"이거랑 저거를 연결하면?" 식의 통찰을 제공하는 스타일입니다.`,
  },
};

// ── 레벨 테이블 ──────────────────────────────────────
export const LEVEL_TABLE = [
  { level: 1, title: "초심자", badge: "✨", xp: 0 },
  { level: 2, title: "학습자", badge: "📝", xp: 100 },
  { level: 3, title: "탐구자", badge: "🔍", xp: 300 },
  { level: 4, title: "연구자", badge: "🧪", xp: 600 },
  { level: 5, title: "전문가", badge: "🎓", xp: 1000 },
  { level: 6, title: "마스터", badge: "⭐", xp: 1500 },
  { level: 7, title: "현자",   badge: "🏆", xp: 2500 },
];

// ── 내부 상태 ────────────────────────────────────────
let stations = [];
let initialized = false;

// ── 초기화 ───────────────────────────────────────────
export async function init() {
  if (initialized) return;
  try {
    stations = await loadStations();
    console.log(`📡 Firestore 스테이션 로드: ${stations.length}개`);
  } catch (err) {
    stations = [];
    console.error("❌ Firestore 스테이션 로드 실패:", err.message);
  }
  initialized = true;
}

// ── 스테이션 생성 ────────────────────────────────────
export async function createStation({ name, description, icon, presetKey, customAgent }) {
  const id = uuidv4();
  const preset = AGENT_PRESETS[presetKey] || AGENT_PRESETS.researcher;
  const agent = customAgent ? { ...preset, ...customAgent } : { ...preset };
  const color = agent.color || preset.color || "#7C3AED";

  const station = {
    id, name, description: description || "",
    icon: icon || agent.avatar || "🧠",
    color,
    created_at: new Date().toISOString(),
    agent: {
      name: agent.name, avatar: agent.avatar,
      personality: agent.personality, tone: agent.tone,
      expertise: agent.expertise, greeting: agent.greeting,
      system_prompt: agent.system_prompt,
    },
    gamification: {
      xp: 0, level: 1, title: "초심자",
      streak_days: 0, last_active: null,
      achievements: [],
      knowledge_coverage: 0,
    },
    stats: {
      source_count: 0, note_count: 0,
      query_count: 0, total_tokens_distilled: 0,
    },
  };

  // Firestore에 저장
  await saveStation(station);
  
  stations.push(station);
  return station;
}

// ── 스테이션 조회 ────────────────────────────────────
export function getAll() { return stations; }
export function getById(id) { return stations.find(s => s.id === id) || null; }

// ── 스테이션 수정 ────────────────────────────────────
export async function updateStation(id, updates) {
  const station = getById(id);
  if (!station) return null;

  const updatable = ["name", "description", "icon", "color"];
  for (const key of updatable) {
    if (updates[key] !== undefined) station[key] = updates[key];
  }
  if (updates.agent) {
    Object.assign(station.agent, updates.agent);
  }
  await saveStation(station);
  return station;
}

// ── 스테이션 삭제 ────────────────────────────────────
export async function deleteStation(id) {
  const idx = stations.findIndex(s => s.id === id);
  if (idx === -1) return false;

  stations.splice(idx, 1);
  await dbDeleteStation(id);
  return true;
}

// ── 스테이션 통계 업데이트 ───────────────────────────
export async function updateStats(id, statUpdates) {
  const station = getById(id);
  if (!station) return;
  Object.assign(station.stats, statUpdates);
  await saveStation(station);
}

// ── 게이미피케이션 업데이트 ──────────────────────────
export async function updateGamification(id, gamUpdates) {
  const station = getById(id);
  if (!station) return;
  Object.assign(station.gamification, gamUpdates);
  await saveStation(station);
}

// ── 스테이션 데이터 경로 (하위 호환성 유지) ────────────
export function getStationDataPath(stationId) {
  return `data/stations/${stationId}`;
}

export { LEVEL_TABLE as LEVELS };

