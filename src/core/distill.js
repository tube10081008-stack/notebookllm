// src/core/distill.js — 콘텐츠 증류 (파싱된 원문 → 원자적 노트)
// v1 distiller.js 계승 + 구조화 출력(스키마)으로 정규식 JSON 세척 제거 (문제 ⑧)
import crypto from "crypto";
import { getLLM } from "../llm/index.js";
import { getAgentBehavior } from "./personas.js";

export const DEFAULT_HALF_LIFE = {
  fact: "permanent",
  concept: "permanent",
  procedure: "5yr",
  opinion: "6mo",
  temporal: "1yr",
};

// Gemini responseSchema (OpenAPI 서브셋). openai provider는 json_object 모드 + 프롬프트 명시로 동작.
const DISTILL_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      title: { type: "string" },
      content: { type: "string" },
      why_saved: { type: "string" },
      type: { type: "string", enum: ["fact", "concept", "procedure", "opinion", "temporal"] },
      topics: { type: "array", items: { type: "string" } },
      confidence: { type: "number" },
      conditions: { type: "array", items: { type: "string" } },
      implications: { type: "array", items: { type: "string" } },
    },
    required: ["title", "content", "type"],
  },
};

export async function distill(parsed, existingTopics = [], agent = null) {
  const { content, metadata } = parsed;

  if (!content || content.trim().length < 100) {
    return [makeNote({ title: metadata?.title, content: content || "" }, metadata)];
  }

  const behavior = agent ? getAgentBehavior(agent.personality) : null;
  const d = behavior?.distill || { maxNotes: 5, preferredTypes: ["fact", "concept"], minConfidence: 0.6, instruction: "" };

  const agentContext = agent
    ? `\n당신의 이름은 "${agent.name}"이고, ${agent.tone} 말투로 작성합니다.
전문 분야: ${agent.expertise}
content 필드를 작성할 때 당신의 전문성과 관점을 반영하세요.

[증류 전략]
${d.instruction}
- 선호 타입: ${d.preferredTypes.join(", ")}
- 최소 신뢰도: ${d.minConfidence} (이 기준 이하의 불확실한 정보는 제외)`
    : "";

  const system = `당신은 지식 관리 전문가입니다.${agentContext}
주어진 콘텐츠를 원자적 개념(Atomic Concept) 단위로 분해하세요.
각 개념은 하나의 독립적인 지식 단위여야 합니다.

기존 토픽 목록 (참고용): ${existingTopics.join(", ") || "없음"}

JSON 배열로만 응답하세요. 각 원소:
{"title":"간결한 제목(한국어, 기술 용어는 English)","content":"핵심 내용을 자신의 표현으로 재작성","why_saved":"왜 중요한지 한 줄","type":"fact|concept|procedure|opinion|temporal","topics":["토픽"],"confidence":0.8,"conditions":["유효 조건"],"implications":["함의"]}

규칙: 최소 1개~최대 ${d.maxNotes}개 / 노트당 하나의 핵심 아이디어 / confidence는 ${d.minConfidence}~1.0`;

  const prompt = `다음 콘텐츠를 원자적 개념으로 분해해주세요:

출처: ${metadata?.title || "알 수 없음"}
URL: ${metadata?.url || "없음"}

---
${content.slice(0, 15000)}
---`;

  let items;
  try {
    items = await getLLM().chat({ system, prompt, json: true, schema: DISTILL_SCHEMA });
    if (!Array.isArray(items)) items = items?.notes || null; // json_object 폴백 대응
  } catch (err) {
    console.warn("⚠️ LLM 증류 실패, 단일 노트로 폴백:", err.message);
    items = null;
  }

  if (!Array.isArray(items) || items.length === 0) {
    return [makeNote({ title: metadata?.title, content }, metadata)];
  }

  return items.slice(0, d.maxNotes).map((item) => makeNote(item, metadata));
}

// 줄 재결합: PDF/워드랩으로 쪼개진 산문 줄을 논리 문장으로 복원 (논문 3).
// 규칙: 이전 줄이 '길고(≥28자)' '문장종결 없이' 끝났으면 = wrap → 다음 줄과 병합.
function reflowLines(rawLines) {
  const terminated = (s) => /[.!?。…]["'”]?$/.test(s) || (s.length >= 16 && /[다요음임]["'”]?$/.test(s));
  const out = [];
  let buf = "";
  for (const line of rawLines) {
    if (!buf) {
      buf = line;
    } else {
      const prevLong = buf.replace(/\s/g, "").length >= 28;
      if (prevLong && !terminated(buf)) buf = `${buf} ${line}`;
      else { out.push(buf); buf = line; }
    }
    if (terminated(buf)) { out.push(buf); buf = ""; }
  }
  if (buf) out.push(buf);
  return out;
}

// ── 자동 분류 v2: 개념(산문) / 참고자료(목록·표) / 혼합 ──
// 논문 근거 수정 (docs/classifier-research.md 참조):
//  · 문장 신호를 줄 단위가 아니라 "전역 문장종결 밀도"로 (PDF 줄바꿈에 불변 — H1/H2)
//  · 목록 신호는 "연속 항목 줄의 최장 런" (산문은 종결부호가 런을 끊음 — H3)
//  · 확신하는 경우만 즉시 결정, 애매 구간은 ambiguous로 표시해 LLM 폴백 (H4/H5)
// 반환: { mode, confidence, reason, ambiguous, features }
export function classifyContent(parsed) {
  const text = (parsed?.content || "").trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 15) return { mode: "concept", confidence: 0.9, ambiguous: false, reason: "짧은 콘텐츠 — 개념" };

  const rawLines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // 줄 재결합 (논문 3, LA-PDFText stitching): '긴 미종결 줄'은 wrap 흔적 → 다음 줄과 이어붙임.
  // 짧은 줄(< 28자)은 진짜 항목일 수 있으니 병합하지 않는다 (목록 파괴 방지).
  // → 줄바꿈된 순수 산문(C2)이 목록으로 오인되던 H1을 구조 단계에서 해소.
  const lines = reflowLines(rawLines);
  const n = lines.length;

  // 전역 문장종결 밀도 (100단어당) — 줄바꿈 파편화에 불변 (H1/H2의 핵심 수정)
  const punctTerms = (text.match(/[.!?。…]/g) || []).length;
  const korTerms = lines.filter((l) => l.length >= 16 && /[다요음임]["'”]?$/.test(l)).length;
  const sentenceDensity = (punctTerms + korTerms) / (words / 100); // 100단어당 문장 수

  // 항목 줄: 짧고, 줄 끝에 문장종결이 없음
  const isEntry = (l) => l.length <= 45 && !/[.!?。…]["'”]?\s*$/.test(l) && !(l.length >= 16 && /[다요음임]["'”]?$/.test(l));
  let run = 0, maxRun = 0, entryLines = 0;
  for (const l of lines) {
    if (isEntry(l)) { run++; maxRun = Math.max(maxRun, run); entryLines++; }
    else run = 0;
  }
  const entryRatio = entryLines / n;
  const delimRatio = lines.filter((l) => l.length <= 80 && /\t|\s{2,}|[|:：,，]/.test(l)).length / n;

  const features = {
    words, lines: n,
    sentenceDensity: +sentenceDensity.toFixed(1),
    maxRun, entryRatio: +entryRatio.toFixed(2), delimRatio: +delimRatio.toFixed(2),
  };
  const fx = `밀도 ${features.sentenceDensity}/100단어, 항목런 ${maxRun}, 항목 ${Math.round(entryRatio * 100)}%`;

  const hasProse = sentenceDensity >= 3;             // 100단어당 3문장 이상 = 산문 존재
  const listBlock = maxRun >= 5 || delimRatio >= 0.55; // 5줄 이상 연속 항목 or 구분자 우세
  const noProse = sentenceDensity < 1;

  // 확신 구간 — 즉시 결정
  if (noProse && (entryRatio >= 0.6 || delimRatio >= 0.55)) {
    return { mode: "reference", confidence: 0.9, ambiguous: false, reason: `목록·표 (${fx})`, features };
  }
  if (hasProse && maxRun < 5 && delimRatio < 0.3) {
    return { mode: "concept", confidence: 0.9, ambiguous: false, reason: `산문형 (${fx})`, features };
  }

  // 애매 구간 — 산문 밀도도 있고 짧은 줄/구분자도 있음 (줄바꿈 산문 vs 표 낀 문서).
  // 논문 4,5: 여기서만 LLM에 위임. LLM 미가용 시 안전 기본값 = hybrid(둘 다 보존, 무손실).
  const fallbackMode = hasProse && listBlock ? "hybrid" : hasProse ? "concept" : "reference";
  return {
    mode: fallbackMode,
    confidence: 0.4,
    ambiguous: true,
    reason: `경계 케이스 — LLM 확인 권장 (${fx})`,
    features,
  };
}

// LLM 폴백 분류 (애매 구간에만 호출 — H5의 비용·과신 통제).
// 통제된 라벨 집합 {concept|reference|hybrid}으로만 분류시킨다.
const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["concept", "reference", "hybrid"] },
    why: { type: "string" },
  },
  required: ["mode"],
};

export async function classifyWithFallback(parsed, { llm = null } = {}) {
  const h = classifyContent(parsed);
  if (!h.ambiguous || !llm) return h;

  try {
    const text = (parsed?.content || "");
    // 앞부분 샘플만 — 판단엔 충분하고 비용은 작다
    const sample = text.slice(0, 2500);
    const system = `당신은 문서 유형 분류기입니다. 주어진 텍스트를 정확히 하나로 분류하세요:
- concept: 설명·논증·서술 위주의 산문 (개념으로 요약·연결할 자료)
- reference: 단어장·표·용어집·목록 위주 (원문 항목을 그대로 보존·검색할 자료)
- hybrid: 설명 산문과 목록·표가 함께 있는 문서 (둘 다 필요)
주의: PDF 추출로 문장이 여러 줄로 쪼개져 짧아 보여도, 내용이 설명 산문이면 concept입니다.
JSON으로만: {"mode":"concept|reference|hybrid","why":"한 줄 근거"}`;
    const r = await llm.chat({ system, prompt: `다음 텍스트를 분류하세요:\n\n---\n${sample}\n---`, json: true, schema: CLASSIFY_SCHEMA });
    const mode = ["concept", "reference", "hybrid"].includes(r?.mode) ? r.mode : h.mode;
    return { mode, confidence: 0.8, ambiguous: false, reason: `LLM 판단: ${r?.why || mode}`, features: h.features, via: "llm" };
  } catch (err) {
    console.warn("⚠️ LLM 분류 폴백 실패, 휴리스틱 유지:", err.message);
    return h; // 휴리스틱 기본값 유지 (안전)
  }
}

// ── 참고 자료 모드 (목록·표·용어집) ──────────────────
// 증류(개념 압축)는 데이터를 파괴한다: 300개 단어 리스트 → "300개짜리 리스트"라는 요약 한 장.
// 참고 자료는 원문을 손실 없이 "검색 가능한 조각"으로 보존한다 (고전 RAG 청킹).
// 각 조각은 실제 항목(단어·병음·뜻)을 그대로 담아, 질의 시 그 내용이 컨텍스트로 들어간다.
export function chunkReference(parsed, { maxChars = 900, maxChunks = 50 } = {}) {
  const { content, metadata } = parsed;
  const text = (content || "").trim();
  if (!text) return [];

  // 줄 단위로 모으되 maxChars를 넘지 않게 (표·리스트의 행 경계를 존중)
  const lines = text.split(/\r?\n/);
  const chunks = [];
  let buf = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length > maxChars && buf.length) {
      chunks.push(buf.join("\n"));
      buf = [];
      len = 0;
    }
    buf.push(line);
    len += line.length + 1;
  }
  if (buf.length) chunks.push(buf.join("\n"));

  const total = Math.min(chunks.length, maxChunks);
  const now = new Date().toISOString();
  return chunks.slice(0, maxChunks).map((chunk, i) => {
    const preview = chunk.replace(/\s+/g, " ").trim().slice(0, 36);
    return {
      id: crypto.randomUUID(),
      title: `${metadata?.title || "자료"} (${i + 1}/${total}) — ${preview}…`,
      content: chunk, // ← 원문 그대로. 무손실.
      my_take: "",
      why_saved: "참고 자료 원문 보존 (검색용 조각)",
      type: "reference",
      topics: [],
      half_life: "permanent",
      confidence: 1,
      conditions: [],
      implications: [],
      source: {
        title: metadata?.title || "",
        url: metadata?.url || "",
        author: metadata?.author || "",
        date: metadata?.date || now,
        raw_ref: metadata?.raw_ref || "",
      },
      created_at: now,
      updated_at: now,
      last_accessed: now,
      access_count: 0,
      archived: false,
    };
  });
}

function makeNote(item, metadata = {}) {
  const type = item.type || "fact";
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: item.title || (item.content || "").slice(0, 50) || "제목 없음",
    content: item.content || "",
    my_take: "",
    why_saved: item.why_saved || "직접 입력된 콘텐츠",
    type,
    topics: Array.isArray(item.topics) ? item.topics : [],
    half_life: DEFAULT_HALF_LIFE[type] || "permanent",
    confidence: Math.min(1, Math.max(0, item.confidence ?? 0.7)),
    conditions: item.conditions || [],
    implications: item.implications || [],
    source: {
      // 불변식 6: 출처 > 요약
      title: metadata?.title || "",
      url: metadata?.url || "",
      author: metadata?.author || "",
      date: metadata?.date || now,
      raw_ref: metadata?.raw_ref || "",
    },
    created_at: now,
    updated_at: now,
    last_accessed: now,
    access_count: 0,
    archived: false,
  };
}
