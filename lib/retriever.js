// lib/retriever.js — 질의 응답 파이프라인 (검색 → 확장 → 합성)
import { generateText, embedText } from "./gemini.js";
import * as vectorStore from "./vector-store.js";
import * as graph from "./graph.js";
import { readFile, writeFile, mkdir } from "fs/promises";

// ── 질의 처리 ────────────────────────────────────────
export async function query(question) {
  // 1) 질문 임베딩
  const questionEmbedding = await embedText(question);

  // 2) 벡터 검색: 상위 10개
  const vectorResults = vectorStore.search(questionEmbedding, 10);

  if (vectorResults.length === 0) {
    return {
      answer:
        "관련 노트를 찾을 수 없습니다. 지식 베이스에 해당 주제의 정보가 아직 없는 것 같습니다.",
      confidence: "low",
      citations: [],
      gaps: ["관련 지식이 전혀 없습니다. 해당 주제의 콘텐츠를 추가해주세요."],
      notesUsed: 0,
    };
  }

  // 3) 그래프 확장: 상위 5개에 대해 2-hop 탐색
  const expandedIds = new Set();
  const allCandidates = new Map(); // id → { score, node }

  // 벡터 결과 추가
  for (const vr of vectorResults) {
    const node = graph.getNode(vr.id);
    if (node && !node.archived) {
      allCandidates.set(vr.id, { vectorScore: vr.score, node });
      expandedIds.add(vr.id);
    }
  }

  // 상위 5개에 대해 그래프 확장
  const topIds = vectorResults.slice(0, 5).map((r) => r.id);
  for (const nid of topIds) {
    const related = graph.findRelated(nid, 2);
    for (const rel of related) {
      if (!expandedIds.has(rel.node.id) && !rel.node.archived) {
        expandedIds.add(rel.node.id);
        allCandidates.set(rel.node.id, {
          vectorScore: 0.3 / rel.depth, // 그래프 확장은 낮은 기본 점수
          node: rel.node,
        });
      }
    }
  }

  // 4) 종합 랭킹
  //    score = relevance*0.5 + confidence*0.2 + recency_decay*0.15 + log(access+1)*0.15
  const ranked = [];

  for (const [id, data] of allCandidates) {
    const node = data.node;
    const relevance = data.vectorScore;
    const confidence = node.confidence ?? 0.5;
    const recency = computeRecencyDecay(node.half_life, node.created_at);
    const popularity = Math.log(1 + (node.access_count || 0)) / 5; // 정규화

    const score =
      relevance * 0.5 +
      confidence * 0.2 +
      recency * 0.15 +
      Math.min(popularity, 1) * 0.15;

    ranked.push({ id, score, relevance, node });
  }

  ranked.sort((a, b) => b.score - a.score);
  const topNotes = ranked.slice(0, 10);

  // 5) LLM으로 답변 합성
  const notesContext = topNotes
    .map(
      (n, i) =>
        `[${i + 1}] ID: ${n.id}\n제목: ${n.node.title}\n타입: ${n.node.type}\n` +
        `신뢰도: ${n.node.confidence}\n관련도: ${n.relevance.toFixed(2)}\n` +
        `내용: ${getNodeContent(n.id).slice(0, 800)}`,
    )
    .join("\n\n---\n\n");

  const systemPrompt = `당신은 "Second Brain" 지식 시스템의 응답 합성 엔진입니다.
사용자의 질문에 대해, 제공된 노트들을 바탕으로 정확하고 유용한 답변을 작성하세요.

규칙:
1. 한국어로 답변하되, 기술 용어는 영어로 유지
2. 각 주장에 [번호] 형식으로 인용 표시
3. 답변 마지막에 신뢰도 평가 (high/medium/low)
4. 노트에서 커버하지 못하는 부분이 있다면 "커버리지 부족 영역"으로 표시

반드시 다음 JSON 형식으로만 응답하세요 (마크다운 코드 블럭 없이):
{
  "answer": "답변 본문 (한국어, 인용 포함)",
  "confidence": "high|medium|low",
  "gaps": ["커버리지 부족 영역 1", "..."]
}`;

  const prompt = `질문: ${question}

참고 노트:
${notesContext}`;

  let synthesized;
  try {
    const raw = await generateText(prompt, systemPrompt);
    const cleaned = raw
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();
    synthesized = JSON.parse(cleaned);
  } catch (err) {
    console.warn("⚠️ 답변 합성 실패:", err.message);
    synthesized = {
      answer: `관련 노트 ${topNotes.length}개를 찾았지만, 답변 합성에 실패했습니다. 노트를 직접 확인해주세요.`,
      confidence: "low",
      gaps: ["LLM 답변 합성 오류"],
    };
  }

  // 6) access_count 업데이트
  for (const note of topNotes) {
    graph.updateNode(note.id, {
      access_count: (note.node.access_count || 0) + 1,
      last_accessed: new Date().toISOString(),
    });
  }
  await graph.save();

  // 7) 최종 응답 구성
  return {
    answer: synthesized.answer,
    confidence: synthesized.confidence || "medium",
    citations: topNotes.map((n) => ({
      noteId: n.id,
      title: n.node.title,
      relevance: Math.round(n.relevance * 100) / 100,
    })),
    gaps: synthesized.gaps || [],
    notesUsed: topNotes.length,
  };
}

// ── Recency Decay 계산 ───────────────────────────────
function computeRecencyDecay(halfLife, createdAt) {
  if (halfLife === "permanent") return 1.0;

  const now = Date.now();
  const created = new Date(createdAt).getTime();
  const ageMs = now - created;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  // half_life를 일수로 변환
  const halfLifeDays = {
    "6mo": 180,
    "1yr": 365,
    "5yr": 1825,
  };

  const hlDays = halfLifeDays[halfLife] || 365;
  // 지수 감소: 0.5^(age/halflife)
  return Math.pow(0.5, ageDays / hlDays);
}

// ── 노트 내용 가져오기 (data/notes에서) ──────────────
import { readFileSync } from "fs";

function getNodeContent(noteId) {
  try {
    const raw = readFileSync(`data/notes/${noteId}.json`, "utf-8");
    const note = JSON.parse(raw);
    return note.content || note.title || "";
  } catch {
    // 파일 없으면 그래프 노드 정보로 폴백
    const node = graph.getNode(noteId);
    if (!node) return "";
    return `${node.title}\n${node.topics?.join(", ") || ""}\n타입: ${node.type}`;
  }
}

// ── 노트 전체 내용 로드 (파일 기반) ──────────────────
export async function loadNoteContent(noteId) {
  try {
    const raw = await readFile(`data/notes/${noteId}.json`, "utf-8");
    const note = JSON.parse(raw);
    return note.content || "";
  } catch {
    return "";
  }
}

export { computeRecencyDecay };
