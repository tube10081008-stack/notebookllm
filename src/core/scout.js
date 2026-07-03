// src/core/scout.js — 수집 에이전트 ("자동 수집"이 아니라 "자동 제안")
//
// 원칙 (불변식 5의 확장): Scout는 지식 베이스에 아무것도 넣지 않는다.
// 후보를 수집함(Inbox)에 제안할 뿐이고, ingest는 인간의 승인 후에만 일어난다.
// "세상의 모든 입력을 다 장기기억에 넣으면 개똥 멍청이가 된다" — 필터가 가치다.
//
// 파이프라인:
//   charter.feeds (공급 방향) + 최근 gaps (수요 신호 — 답변이 드러낸 결핍)
//   → 피드 수집 → 키워드 게이트(topics/gaps 매칭, exclude 차단)
//   → 신규성 게이트(기존 벡터와 비교 — 이미 아는 건 제안하지 않는다)
//   → 상위 max_proposals개만 Inbox에 제안
import crypto from "crypto";
import * as ws from "../storage/workspace.js";
import { getLLM } from "../llm/index.js";
import { cosine } from "./similarity.js";
import { getCharter } from "./charter.js";
import { assertPublicURL } from "./parsers.js";

const KNOWN_SIMILARITY = 0.85;   // 이 이상 유사하면 "이미 아는 것" — 제안하지 않음
const EMBED_BUDGET = 20;         // 스카우트 1회당 임베딩 호출 상한 (비용 통제)
const ITEMS_PER_FEED = 30;

// ── 피드 수집 (RSS 2.0 + Atom, 의존성 없는 경량 파서) ──

// 알려진 소스의 주소를 "구독에 적합한" 형태로 정규화한다.
// arXiv: API 엔드포인트(export.arxiv.org/api)는 공유 IP(Vercel)를 자주 429로 차단하지만,
//        구독 전용 RSS 서버(rss.arxiv.org)는 CDN 기반이라 관대하다. cat: 쿼리를 자동 변환.
export function normalizeFeedURL(url) {
  const arxivCat = url.match(/export\.arxiv\.org\/api\/query\?[^#]*search_query=cat(?::|%3A)([\w.-]+)/i);
  if (arxivCat) return `https://rss.arxiv.org/rss/${arxivCat[1]}`;
  // http로 적힌 arXiv 주소는 https로 (redirect 왕복 = 요청 2배 → 429 유발 요인)
  if (/^http:\/\/(export\.|rss\.)?arxiv\.org/i.test(url)) return url.replace(/^http:/i, "https:");
  return url;
}

async function fetchText(url, retried = false) {
  await assertPublicURL(url);
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; BrainStation-Scout/3.0)" },
    signal: AbortSignal.timeout(15000),
    redirect: "follow",
  });
  // 일시적 제한(429)·과부하(503)는 잠시 기다렸다 1회 재시도
  if ((res.status === 429 || res.status === 503) && !retried) {
    await new Promise((r) => setTimeout(r, 4000));
    return fetchText(url, true);
  }
  if (!res.ok) throw new Error(`가져오기 실패 (${res.status}): ${url}`);
  return (await res.text()).slice(0, 2_000_000);
}

const FEED_HINT = /<(rss|feed)[\s>]/i;

// 피드 자동 감지 — 사용자는 RSS를 몰라도 된다.
// 유튜브 채널 주소·블로그 홈 주소를 그대로 넣으면 진짜 피드 주소를 스스로 찾아낸다.
//   ① 이미 XML 피드면 그대로 사용
//   ② YouTube 채널/핸들 페이지 → channelId 추출 → 공식 피드
//   ③ HTML의 <link rel="alternate" type="rss/atom"> 표준 자동발견
//   ④ 흔한 경로(/feed, /rss) 폴백
async function resolveFeed(url, depth = 0) {
  if (depth === 0) url = normalizeFeedURL(url);
  const body = await fetchText(url);
  if (FEED_HINT.test(body.slice(0, 3000))) return { feedUrl: url, xml: body };
  if (depth >= 2) throw new Error(`피드를 찾지 못했습니다: ${url}`);

  // ② YouTube 채널/핸들
  if (/youtube\.com|youtu\.be/i.test(url)) {
    const m = url.match(/channel\/(UC[\w-]{22})/) || body.match(/"channelId":"(UC[\w-]{22})"/);
    if (m) return resolveFeed(`https://www.youtube.com/feeds/videos.xml?channel_id=${m[1]}`, depth + 1);
  }

  // ③ RSS 자동발견 (<link rel="alternate" type="application/rss+xml" href="...">)
  const linkTags = body.match(/<link\b[^>]*>/gi) || [];
  for (const tag of linkTags) {
    if (!/rel=["']alternate["']/i.test(tag)) continue;
    if (!/application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (href) return resolveFeed(new URL(href, url).toString(), depth + 1);
  }

  // ④ 흔한 피드 경로 폴백
  const base = url.replace(/\/+$/, "");
  for (const suffix of ["/feed", "/rss"]) {
    try { return await resolveFeed(base + suffix, depth + 1); } catch { /* 다음 후보 */ }
  }

  throw new Error(`피드를 찾지 못했습니다. 사이트가 RSS를 제공하지 않는 것 같습니다: ${url}`);
}

export async function fetchFeed(url) {
  const { feedUrl, xml } = await resolveFeed(url);
  return parseFeed(xml, feedUrl);
}

export function parseFeed(xml, feedUrl = "") {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];

  for (const block of blocks.slice(0, ITEMS_PER_FEED)) {
    const title = pick(block, "title");
    // Atom은 <link href="..."/>, RSS는 <link>텍스트</link>
    const linkHref = block.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1];
    const link = linkHref || pick(block, "link") || pick(block, "guid") || "";
    const summary = pick(block, "description") || pick(block, "summary") || pick(block, "content") || "";
    const published = pick(block, "pubDate") || pick(block, "updated") || pick(block, "published") || "";
    if (!title && !link) continue;
    items.push({
      title: clean(title).slice(0, 300),
      url: clean(link).slice(0, 1000),
      summary: clean(summary).slice(0, 600),
      published,
      feed: feedUrl,
    });
  }
  return items;
}

function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? m[1] : "";
}

function clean(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── 키워드 매칭 (공급 방향 topics + 수요 신호 gaps) ──
function keywordMatches(text, keywords) {
  const low = text.toLowerCase();
  return keywords.filter((k) => k && low.includes(k.toLowerCase()));
}

// ── 스카우트 실행 ─────────────────────────────────────
export async function runScout(sid) {
  const charter = await getCharter(sid);
  if (!charter.feeds.length) {
    return { proposed: [], skipped: {}, message: "헌장에 신뢰 소스(feeds)가 없습니다. 수집함 탭에서 헌장을 편집해 RSS/Atom 소스를 추가하세요." };
  }

  const gaps = await ws.loadRecentGaps(sid, 20);
  const gapKeywords = gaps.map((g) => g.gap);
  const supplyKeywords = charter.topics;
  const excludeKeywords = charter.exclude;

  // 이미 제안했거나 처분된 URL은 다시 제안하지 않는다
  const inbox = await ws.loadInbox(sid);
  const seenUrls = new Set(inbox.items.map((i) => i.url));

  // 1) 피드 수집
  const collected = [];
  const feedErrors = [];
  for (const feedUrl of charter.feeds) {
    try {
      collected.push(...await fetchFeed(feedUrl));
    } catch (err) {
      feedErrors.push({ feed: feedUrl, error: err.message });
    }
  }

  // 2) 키워드 게이트
  const skipped = { seen: 0, excluded: 0, noMatch: 0, known: 0 };
  const candidates = [];
  for (const item of collected) {
    if (!item.url || seenUrls.has(item.url)) { skipped.seen++; continue; }
    seenUrls.add(item.url);

    const text = `${item.title} ${item.summary}`;
    if (keywordMatches(text, excludeKeywords).length > 0) { skipped.excluded++; continue; }

    const matchedTopics = keywordMatches(text, supplyKeywords);
    const matchedGaps = keywordMatches(text, gapKeywords);
    // 토픽이 정의되어 있으면 매칭 필수. 미정의(초기) 헌장이면 전부 통과.
    if (supplyKeywords.length > 0 && matchedTopics.length === 0 && matchedGaps.length === 0) {
      skipped.noMatch++;
      continue;
    }
    candidates.push({
      ...item,
      matchedTopics,
      matchedGaps,
      // 결핍(수요)을 채우는 소스에 가산점 — 결핍 주도 수집의 핵심
      keywordScore: matchedTopics.length + matchedGaps.length * 2,
    });
  }

  // 3) 신규성 게이트 (임베딩 예산 내에서 키워드 상위만)
  candidates.sort((a, b) => b.keywordScore - a.keywordScore);
  const vectorStore = await ws.loadVectors(sid);
  const existing = Object.values(vectorStore.items || {});
  const llm = getLLM();

  const proposals = [];
  for (const c of candidates.slice(0, EMBED_BUDGET)) {
    let novelty = 1;
    if (existing.length > 0) {
      try {
        const emb = await llm.embedOne(`${c.title} ${c.summary}`);
        let maxSim = 0;
        for (const item of existing) maxSim = Math.max(maxSim, cosine(emb, item.v));
        if (maxSim > KNOWN_SIMILARITY) { skipped.known++; continue; }
        novelty = 1 - maxSim;
      } catch { /* 임베딩 실패 시 신규성 판단 없이 통과 */ }
    }
    proposals.push({
      id: crypto.randomUUID(),
      title: c.title,
      url: c.url,
      summary: c.summary,
      feed: c.feed,
      published: c.published,
      matchedTopics: c.matchedTopics,
      matchedGaps: c.matchedGaps,
      novelty: Math.round(novelty * 100) / 100,
      score: Math.round((c.keywordScore + novelty) * 100) / 100,
      status: "pending",
      proposed_at: new Date().toISOString(),
    });
  }

  // 4) 예산 내 상위만 제안
  proposals.sort((a, b) => b.score - a.score);
  const finalProposals = proposals.slice(0, charter.max_proposals);
  inbox.items.push(...finalProposals);
  await ws.saveInbox(sid, inbox);

  await ws.appendEvent(sid, "scout.proposed", {
    feeds: charter.feeds.length,
    collected: collected.length,
    proposed: finalProposals.length,
    gapsUsed: gapKeywords.length,
    skipped,
    feedErrors: feedErrors.length,
  });

  return {
    proposed: finalProposals,
    collected: collected.length,
    gapsUsed: gapKeywords.slice(0, 10),
    skipped,
    feedErrors,
  };
}
