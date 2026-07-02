// lib/gamification.js — XP, 레벨, 업적, streak 관리
import { LEVEL_TABLE } from "./station-manager.js";
import * as stationManager from "./station-manager.js";

// ── XP 보상 테이블 ──────────────────────────────────
const XP_REWARDS = {
  source_added:     20,  // 소스 추가
  note_created:     15,  // 노트 1개 생성
  query_asked:       5,  // 질문하기
  my_take_written:  25,  // 나의 해석 작성
  note_reviewed:    10,  // 검증 완료
  cross_reference:  30,  // 크로스 레퍼런스
  daily_streak:     10,  // 일일 사용 (×streak일수)
};

// ── 업적 정의 ────────────────────────────────────────
const ACHIEVEMENTS = {
  first_source:    { title: "첫 걸음",       badge: "🌱", condition: "첫 소스 추가" },
  ten_notes:       { title: "지식의 씨앗",    badge: "🌿", condition: "노트 10개" },
  fifty_notes:     { title: "숲을 이루다",    badge: "🌳", condition: "노트 50개" },
  ten_my_takes:    { title: "통찰의 불꽃",    badge: "🔥", condition: "나의 해석 10개 작성" },
  five_cross_refs: { title: "연결의 달인",    badge: "🔗", condition: "크로스 레퍼런스 5회" },
  seven_streak:    { title: "일주일 연속",    badge: "📅", condition: "7일 streak" },
  five_stations:   { title: "만물박사",       badge: "🌐", condition: "5개 이상 스테이션" },
  first_council:   { title: "협의회 소집",    badge: "🏛️", condition: "첫 Council 모드" },
  hundred_queries: { title: "질문의 달인",    badge: "❓", condition: "100번 질문" },
  level_five:      { title: "전문가 등극",    badge: "🎓", condition: "레벨 5 달성" },
};

// ── XP 부여 + 레벨업 체크 ────────────────────────────
export async function grantXP(stationId, action, multiplier = 1) {
  const station = stationManager.getById(stationId);
  if (!station) return null;

  const baseXP = XP_REWARDS[action] || 0;
  const xpGain = Math.round(baseXP * multiplier);
  if (xpGain === 0) return station.gamification;

  const gam = station.gamification;
  const oldLevel = gam.level;
  gam.xp += xpGain;

  // 레벨 계산
  let newLevel = 1;
  for (const entry of LEVEL_TABLE) {
    if (gam.xp >= entry.xp) newLevel = entry.level;
  }
  gam.level = newLevel;
  gam.title = LEVEL_TABLE.find(l => l.level === newLevel)?.title || "초심자";

  const leveledUp = newLevel > oldLevel;

  // streak 업데이트
  const today = new Date().toISOString().slice(0, 10);
  if (gam.last_active !== today) {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (gam.last_active === yesterday) {
      gam.streak_days += 1;
    } else if (gam.last_active !== today) {
      gam.streak_days = 1;
    }
    gam.last_active = today;

    // streak 보너스 XP
    if (gam.streak_days > 1) {
      gam.xp += XP_REWARDS.daily_streak * Math.min(gam.streak_days, 7);
    }
  }

  await stationManager.updateGamification(stationId, gam);

  return {
    xpGain,
    totalXP: gam.xp,
    level: gam.level,
    title: gam.title,
    leveledUp,
    streak: gam.streak_days,
  };
}

// ── 업적 체크 + 달성 ─────────────────────────────────
export async function checkAchievements(stationId) {
  const station = stationManager.getById(stationId);
  if (!station) return [];

  const gam = station.gamification;
  const stats = station.stats;
  const newAchievements = [];

  const checks = {
    first_source:    stats.source_count >= 1,
    ten_notes:       stats.note_count >= 10,
    fifty_notes:     stats.note_count >= 50,
    hundred_queries: stats.query_count >= 100,
    seven_streak:    gam.streak_days >= 7,
    level_five:      gam.level >= 5,
    five_stations:   stationManager.getAll().length >= 5,
  };

  for (const [key, met] of Object.entries(checks)) {
    if (met && !gam.achievements.includes(key)) {
      gam.achievements.push(key);
      newAchievements.push({
        key,
        ...ACHIEVEMENTS[key],
      });
    }
  }

  if (newAchievements.length > 0) {
    await stationManager.updateGamification(stationId, gam);
  }

  return newAchievements;
}

// ── 업적 목록 (달성 여부 포함) ───────────────────────
export function getAchievementList(stationId) {
  const station = stationManager.getById(stationId);
  const earned = station?.gamification.achievements || [];

  return Object.entries(ACHIEVEMENTS).map(([key, ach]) => ({
    key,
    ...ach,
    earned: earned.includes(key),
  }));
}

// ── 다음 레벨까지 진행도 ─────────────────────────────
export function getLevelProgress(stationId) {
  const station = stationManager.getById(stationId);
  if (!station) return null;

  const gam = station.gamification;
  const currentEntry = LEVEL_TABLE.find(l => l.level === gam.level);
  const nextEntry = LEVEL_TABLE.find(l => l.level === gam.level + 1);

  if (!nextEntry) {
    return { current: gam.xp, needed: currentEntry.xp, progress: 1.0, nextTitle: "최고 레벨" };
  }

  const progress = (gam.xp - currentEntry.xp) / (nextEntry.xp - currentEntry.xp);
  return {
    current: gam.xp,
    currentLevelXP: currentEntry.xp,
    nextLevelXP: nextEntry.xp,
    progress: Math.min(1, Math.max(0, progress)),
    nextTitle: nextEntry.title,
    nextBadge: nextEntry.badge,
  };
}

export { XP_REWARDS, ACHIEVEMENTS };
