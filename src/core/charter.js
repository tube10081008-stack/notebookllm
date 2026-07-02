// src/core/charter.js — 지식 헌장 (스테이션의 소스·학습 방향성)
//
// 설문으로 받은 방향성이 canonical 아티팩트가 된다. 헌장은 세 곳에 영향을 준다:
//   1. 수집: Scout의 검색 대상(feeds)·필터(topics/exclude)·예산(max_proposals)
//   2. 학습: 거절 사유가 learned에 누적 — P-Reinforce의 policy 강화 루프
//      (과거 진실을 고치지 않고 미래 행동만 바꾼다)
//   3. 방향: 파인튜닝 데이터셋을 만들 때 "전문 분야" 비율의 기준선
import * as ws from "../storage/workspace.js";

export function defaultCharter() {
  return {
    purpose: "",          // 이 스테이션이 존재하는 이유 (설문 Q1)
    topics: [],           // 핵심 토픽 키워드 (설문 Q2)
    exclude: [],          // 제외 키워드 (설문 Q3)
    feeds: [],            // 신뢰 소스 화이트리스트: RSS/Atom URL (설문 Q4)
                          //   - arXiv: http://export.arxiv.org/api/query?search_query=...
                          //   - YouTube 채널: https://www.youtube.com/feeds/videos.xml?channel_id=...
                          //   - 블로그/뉴스레터 RSS
    max_proposals: 8,     // 스카우트 1회 제안 상한 (소방호스 방지)
    learned: [],          // 거절 사유 누적 (append-only 정책 학습)
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

export function sanitizeCharterInput(input = {}) {
  const out = {};
  if (input.purpose !== undefined) out.purpose = String(input.purpose).slice(0, 500);
  if (input.topics !== undefined) out.topics = normalizeList(input.topics).slice(0, 30);
  if (input.exclude !== undefined) out.exclude = normalizeList(input.exclude).slice(0, 30);
  if (input.feeds !== undefined) {
    out.feeds = normalizeList(input.feeds)
      .filter((u) => /^https?:\/\//i.test(u))
      .slice(0, 20);
  }
  if (input.max_proposals !== undefined) {
    out.max_proposals = Math.max(1, Math.min(20, Number(input.max_proposals) || 8));
  }
  return out;
}

export async function getCharter(sid) {
  return (await ws.loadCharter(sid)) || defaultCharter();
}

export async function updateCharter(sid, input) {
  const charter = await getCharter(sid);
  Object.assign(charter, sanitizeCharterInput(input));
  await ws.saveCharter(sid, charter);
  await ws.appendEvent(sid, "charter.updated", { fields: Object.keys(sanitizeCharterInput(input)) });
  return charter;
}

// 거절은 미래의 수집을 바꾸는 학습 신호다 (append-only — 불변식 3의 정신)
export async function recordRejection(sid, { url, title, reason }) {
  const charter = await getCharter(sid);
  charter.learned.push({
    ts: new Date().toISOString(),
    url: url || "",
    title: (title || "").slice(0, 200),
    reason: (reason || "").slice(0, 300),
  });
  await ws.saveCharter(sid, charter);
  return charter;
}
