// server.js — BrainStation Express 서버 (멀티 에이전트 워크스테이션)
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import multer from "multer";
import { mkdir, readFile, writeFile, readdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { embedText } from "./lib/gemini.js";
import { parseText, parseURL, parsePDF, parseYouTube } from "./lib/parser.js";
import { distill, proposeLinks } from "./lib/distiller.js";
// gc-agent.js는 로컬 파일 시스템(vector-store.js, graph.js)에 의존하므로
// Vercel 서버리스 환경에서는 import하지 않습니다.
import * as stationManager from "./lib/station-manager.js";
import { grantXP, checkAchievements, getAchievementList, getLevelProgress } from "./lib/gamification.js";
import { runCouncil, crossStationSearch } from "./lib/council.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import {
  loadNote,
  saveNote,
  deleteNote,
  loadAllNotes,
  saveRawSource,
  loadVectors,
  saveVector,
  deleteVector,
  loadGraph,
  saveGraph,
  loadTaxonomy,
  saveTaxonomy,
  loadChats,
  saveChatSession
} from "./lib/db.js";

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, nA = 0, nB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; nA += a[i]*a[i]; nB += b[i]*b[i]; }
  const d = Math.sqrt(nA) * Math.sqrt(nB);
  return d === 0 ? 0 : dot / d;
}

// ── Multer ───────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["application/pdf", "image/png", "image/jpeg", "image/jpg", "image/webp"];
    if (allowedTypes.includes(file.mimetype)) cb(null, true);
    else cb(new Error("PDF 또는 이미지 파일만 업로드 가능합니다."));
  },
});

// ── Express ──────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── 지연 초기화 미들웨어 (모든 라우트 전에 등록!) ─────
let initialized = false;
async function ensureInit() {
  if (!initialized) {
    await stationManager.init();
    initialized = true;
  }
}

app.use(async (req, res, next) => {
  try {
    await ensureInit();
    next();
  } catch (err) {
    next(err);
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  스테이션 API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 프리셋 목록
app.get("/api/presets", (req, res) => {
  const presets = Object.entries(stationManager.AGENT_PRESETS).map(([key, p]) => ({
    key, name: p.name, avatar: p.avatar, tone: p.tone,
    expertise: p.expertise, greeting: p.greeting, color: p.color,
  }));
  res.json({ presets });
});

// 스테이션 목록
app.get("/api/stations", (req, res) => {
  res.json({ stations: stationManager.getAll() });
});

// 스테이션 생성
app.post("/api/stations", async (req, res) => {
  try {
    const station = await stationManager.createStation(req.body);
    res.json({ station });
  } catch (err) {
    res.status(500).json({ error: `스테이션 생성 실패: ${err.message}` });
  }
});

// 스테이션 상세
app.get("/api/stations/:id", (req, res) => {
  const station = stationManager.getById(req.params.id);
  if (!station) return res.status(404).json({ error: "스테이션을 찾을 수 없습니다." });
  res.json({ station });
});

// 스테이션 수정
app.put("/api/stations/:id", async (req, res) => {
  try {
    const station = await stationManager.updateStation(req.params.id, req.body);
    if (!station) return res.status(404).json({ error: "스테이션을 찾을 수 없습니다." });
    res.json({ station });
  } catch (err) {
    res.status(500).json({ error: `스테이션 수정 실패: ${err.message}` });
  }
});

// 스테이션 삭제
app.delete("/api/stations/:id", async (req, res) => {
  try {
    const ok = await stationManager.deleteStation(req.params.id);
    if (!ok) return res.status(404).json({ error: "스테이션을 찾을 수 없습니다." });
    res.json({ message: "스테이션이 삭제되었습니다." });
  } catch (err) {
    res.status(500).json({ error: `스테이션 삭제 실패: ${err.message}` });
  }
});

// ── 소스 입력 (Ingest) ───────────────────────────────
app.post("/api/stations/:id/ingest", upload.single("file"), async (req, res) => {
  const sid = req.params.id;
  const station = stationManager.getById(sid);
  if (!station) return res.status(404).json({ error: "스테이션을 찾을 수 없습니다." });

  try {
    let parsed;
    if (req.file) {
      const decodedFilename = Buffer.from(req.file.originalname, "latin1").toString("utf8");
      if (req.file.mimetype.startsWith("image/")) {
        const { parseImage } = await import("./lib/parser.js");
        parsed = await parseImage(req.file.buffer, decodedFilename, req.file.mimetype);
      } else {
        parsed = await parsePDF(req.file.buffer, decodedFilename);
      }
    } else {
      const { type, content } = req.body;
      if (!type || !content) return res.status(400).json({ error: "type과 content가 필요합니다." });
      switch (type) {
        case "text": parsed = parseText(content); break;
        case "url": parsed = await parseURL(content); break;
        case "youtube": parsed = await parseYouTube(content); break;
        default: return res.status(400).json({ error: `지원하지 않는 type: ${type}` });
      }
    }

    // ── 원문(Raw Content) 무수정 영구 보관 ───────────────
    const safeTitle = (parsed.metadata.title || "source")
      .replace(/[^a-zA-Z0-9가-힣_-]/g, "_")
      .slice(0, 50);
    const rawFilename = `raw_${Date.now()}_${safeTitle}`;
    await saveRawSource(sid, rawFilename, {
      original_parsed: parsed,
      saved_at: new Date().toISOString()
    });

    // 증류 (에이전트 성격 반영)
    const taxonomy = await loadTaxonomy(sid);
    const notes = await distill(parsed, Object.keys(taxonomy.topics || {}), station.agent);

    // 기존 그래프 로드
    const graphData = await loadGraph(sid);

    const createdNotes = [];
    for (const note of notes) {
      note.station_id = sid;

      // 임베딩 및 벡터 저장
      const embedding = await embedText(`${note.title} ${note.content}`);
      await saveVector(sid, note.id, embedding, { title: note.title, type: note.type });

      // 그래프 노드
      graphData.nodes[note.id] = {
        id: note.id, title: note.title, type: note.type,
        topics: note.topics, confidence: note.confidence,
        created_at: note.created_at, access_count: 0, archived: false,
      };

      // 노트 저장
      await saveNote(sid, note);

      // taxonomy 업데이트
      for (const t of note.topics || []) {
        taxonomy.topics[t] = (taxonomy.topics[t] || 0) + 1;
      }

      createdNotes.push(note);
    }

    await saveGraph(sid, graphData);
    taxonomy.updated_at = new Date().toISOString();
    await saveTaxonomy(sid, taxonomy);

    // 통계 + 게이미피케이션
    await stationManager.updateStats(sid, {
      source_count: (station.stats.source_count || 0) + 1,
      note_count: (station.stats.note_count || 0) + createdNotes.length,
    });

    const xpResult = await grantXP(sid, "source_added");
    for (const _ of createdNotes) await grantXP(sid, "note_created");
    const achievements = await checkAchievements(sid);

    res.json({
      message: `${station.agent.name}이(가) ${createdNotes.length}개의 노트를 생성했습니다.`,
      notes: createdNotes,
      xp: xpResult,
      achievements,
    });
  } catch (err) {
    console.error("❌ 수집 오류:", err);
    res.status(500).json({ error: `수집 실패: ${err.message}` });
  }
});

// ── 질문 (Query) ─────────────────────────────────────
app.post("/api/stations/:id/query", async (req, res) => {
  const sid = req.params.id;
  const station = stationManager.getById(sid);
  if (!station) return res.status(404).json({ error: "스테이션을 찾을 수 없습니다." });

  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: "question이 필요합니다." });

    // 벡터 검색
    const qEmbed = await embedText(question);
    const vectors = await loadVectors(sid);
    const ids = Object.keys(vectors);

    // ── 에이전트별 검색 전략 ──────────────────────
    const { getAgentBehavior } = await import("./lib/agent-config.js");
    const behavior = getAgentBehavior(station.agent?.personality);
    const searchConfig = behavior.search;

    let scored = ids
      .map(id => {
        let score = cosine(qEmbed, vectors[id]?.embedding);

        // 최신 노트 가산점 (recencyBias)
        if (searchConfig.recencyBias > 0 && vectors[id]?.created_at) {
          const ageMs = Date.now() - new Date(vectors[id].created_at).getTime();
          const ageDays = ageMs / (1000 * 60 * 60 * 24);
          const recencyBoost = Math.max(0, 1 - ageDays / 365) * searchConfig.recencyBias;
          score += recencyBoost;
        }

        // 신뢰도 가중치 (confidenceWeight)
        if (searchConfig.confidenceWeight > 0 && vectors[id]?.confidence) {
          score += vectors[id].confidence * searchConfig.confidenceWeight;
        }

        return { id, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, searchConfig.topK);

    // 노트 내용 로드 (에이전트별 topK에 따라 다른 수의 노트 참조)
    const noteContents = [];
    for (const s of scored) {
      const note = await loadNote(sid, s.id);
      if (note) {
        noteContents.push({ ...note, relevance: s.score });
      }
    }

    // ── 에이전트별 답변 스타일 주입 ──────────────
    const { generateText } = await import("./lib/gemini.js");
    const context = noteContents
      .map((n, i) => `[${i+1}] "${n.title}" (타입: ${n.type}, confidence: ${n.confidence}): ${n.content?.slice(0, 2000) || ""}`)
      .join("\n\n---\n\n");

    // ── 대화 메모리: 이전 대화 맥락 로드 ──────────
    const chatMemorySize = behavior.answer.chatMemory || 5;
    let chatMemoryContext = "";
    try {
      const prevChats = await loadChats(sid);
      const recentChats = prevChats.slice(-chatMemorySize);
      if (recentChats.length > 0) {
        chatMemoryContext = `\n\n[이전 대화 맥락 (최근 ${recentChats.length}개)]\n` +
          recentChats.map((c, i) => `대화${i+1}) 사용자: ${c.question || ""}\n에이전트: ${c.answer || ""}`).join("\n---\n");
      }
    } catch { /* 대화 로드 실패해도 계속 진행 */ }

    const systemPrompt = `${station.agent.system_prompt}

당신은 "${station.name}" 스테이션의 에이전트입니다.
제공된 노트를 바탕으로 답변하세요.

[답변 스타일 및 인용 볼드체 규칙]
- 노트를 바탕으로 핵심 개념, 키워드 혹은 주장을 서술할 때 인용 번호와 함께 반드시 볼드(Bold)체로 감싸서 작성하세요.
- 형식 예시: **'핵심 개념(영문명)'[번호]**
- 여러 노트를 인용할 때는 **'핵심 개념(영문명)'[번호1][번호2]** 형태로 볼드체 안에 인용 번호까지 포함해 묶으세요.
- 예시: 우리가 이전에 나눈 **'역사적 위인들의 위대한 끈기(Long-term Breath)'[1]**와 **'사도 요한이 경고한 세 가지 신기루(The Three Illusions)'[3]**를 연결하면, **'뇌과학적 회복탄력성(Resilience)'[1][4]**이라는 통찰이 나옵니다.

${behavior.answer.style}

[대화 메모리 규칙]
- 이전 대화가 있으면 맥락을 이어가세요. "아까 말한...", "이전에 물어본..." 등의 후속 질문에 자연스럽게 응답하세요.
- 이전 대화에서 다룬 내용을 반복하지 마세요. 새로운 관점이나 깊이를 더하세요.
- 사용자가 이전 대화를 참조하면, 해당 대화 내용을 바탕으로 답변하세요.

반드시 다음 JSON 형식으로만 응답하세요 (마크다운 코드 블럭 없이):
{"answer":"답변","confidence":"high|medium|low","gaps":["부족한 영역"]}`;

    let promptParts = [];
    if (chatMemoryContext) promptParts.push(chatMemoryContext);
    if (noteContents.length > 0) promptParts.push(`\n\n[참고 노트]\n${context}`);
    
    const prompt = noteContents.length > 0 || chatMemoryContext
      ? `질문: ${question}${promptParts.join("")}`
      : `질문: ${question}\n\n(참고 노트 없음, 이전 대화 없음 — 일반 지식으로 답변)`;

    let synthesized;
    try {
      const raw = await generateText(prompt, systemPrompt);
      synthesized = JSON.parse(raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim());
    } catch {
      synthesized = { answer: `관련 노트 ${noteContents.length}개를 찾았지만 합성에 실패했습니다.`, confidence: "low", gaps: [] };
    }

    // 크로스 스테이션 추천
    let crossRecommendations = [];
    try {
      crossRecommendations = await crossStationSearch(question, sid);
    } catch { /* 실패해도 계속 */ }

    // 통계 + XP
    await stationManager.updateStats(sid, { query_count: (station.stats.query_count || 0) + 1 });
    const xpResult = await grantXP(sid, "query_asked");

    // ── 대화 내역(Chat History) 영구 아카이빙 ─────────────
    const chatSession = {
      timestamp: new Date().toISOString(),
      question,
      answer: synthesized.answer,
      confidence: synthesized.confidence || "medium",
      citations: noteContents.slice(0, 5).map(n => ({
        noteId: n.id, title: n.title, relevance: Math.round(n.relevance * 100) / 100,
      })),
      crossRecommendations: crossRecommendations.slice(0, 3).map(r => ({
        stationId: r.stationId, stationName: r.stationName, agentAvatar: r.agentAvatar, title: r.title, score: r.score
      }))
    };
    await saveChatSession(sid, chatSession);

    res.json({
      answer: synthesized.answer,
      confidence: synthesized.confidence || "medium",
      citations: noteContents.slice(0, 5).map(n => ({
        noteId: n.id, title: n.title, relevance: Math.round(n.relevance * 100) / 100,
      })),
      gaps: synthesized.gaps || [],
      notesUsed: noteContents.length,
      crossRecommendations: crossRecommendations.slice(0, 3),
      agentName: station.agent.name,
      agentAvatar: station.agent.avatar,
      xp: xpResult,
    });
  } catch (err) {
    console.error("❌ 질의 오류:", err);
    res.status(500).json({ error: `질의 실패: ${err.message}` });
  }
});

// ── 대화 목록 (Chat History) 조회 ──────────────────────
app.get("/api/stations/:id/chats", async (req, res) => {
  const sid = req.params.id;
  try {
    const chats = await loadChats(sid);
    res.json({ chats });
  } catch (err) {
    res.status(500).json({ error: `대화 조회 실패: ${err.message}` });
  }
});

// ── 노트 목록 ────────────────────────────────────────
app.get("/api/stations/:id/notes", async (req, res) => {
  const sid = req.params.id;
  try {
    let notes = await loadAllNotes(sid);

    const { search, topic, archived } = req.query;
    if (archived !== "true" && archived !== "all") notes = notes.filter(n => !n.archived);
    if (topic) notes = notes.filter(n => n.topics?.includes(topic));
    if (search) {
      const q = search.toLowerCase();
      notes = notes.filter(n => n.title?.toLowerCase().includes(q) || n.content?.toLowerCase().includes(q));
    }
    notes.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({
      total: notes.length,
      notes: notes.map(n => ({
        id: n.id, title: n.title, type: n.type, topics: n.topics,
        confidence: n.confidence, half_life: n.half_life, my_take: n.my_take,
        created_at: n.created_at, archived: n.archived, source: n.source,
        contentPreview: n.content?.slice(0, 200),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: `노트 목록 실패: ${err.message}` });
  }
});

// ── 노트 상세 ────────────────────────────────────────
app.get("/api/stations/:id/notes/:noteId", async (req, res) => {
  try {
    const note = await loadNote(req.params.id, req.params.noteId);
    if (!note) return res.status(404).json({ error: "노트를 찾을 수 없습니다." });
    res.json(note);
  } catch { res.status(404).json({ error: "노트를 찾을 수 없습니다." }); }
});

// ── 노트 수정 (my_take 등) ──────────────────────────
app.put("/api/stations/:id/notes/:noteId", async (req, res) => {
  const sid = req.params.id;
  const nid = req.params.noteId;
  try {
    const note = await loadNote(sid, nid);
    if (!note) return res.status(404).json({ error: "노트를 찾을 수 없습니다." });

    const updatable = ["my_take", "title", "content", "type", "topics", "half_life", "confidence", "archived"];
    for (const k of updatable) { if (req.body[k] !== undefined) note[k] = req.body[k]; }
    note.updated_at = new Date().toISOString();

    await saveNote(sid, note);

    // my_take 작성 시 XP
    if (req.body.my_take && req.body.my_take.length > 0) {
      await grantXP(sid, "my_take_written");
    }

    res.json({ message: "노트가 수정되었습니다.", note });
  } catch (err) {
    res.status(500).json({ error: `노트 수정 실패: ${err.message}` });
  }
});

// ── 노트 삭제 ────────────────────────────────────────
app.delete("/api/stations/:id/notes/:noteId", async (req, res) => {
  const sid = req.params.id;
  const nid = req.params.noteId;
  try {
    await deleteNote(sid, nid);

    // 벡터 제거
    await deleteVector(sid, nid);

    // 그래프 제거
    const graphData = await loadGraph(sid);
    delete graphData.nodes[nid];
    graphData.edges = graphData.edges.filter(e => e.source !== nid && e.target !== nid);
    await saveGraph(sid, graphData);

    res.json({ message: "노트가 삭제되었습니다." });
  } catch (err) {
    res.status(500).json({ error: `노트 삭제 실패: ${err.message}` });
  }
});

// ── 그래프 데이터 ────────────────────────────────────
app.get("/api/stations/:id/graph", async (req, res) => {
  try {
    const data = await loadGraph(req.params.id);
    res.json({ nodes: Object.values(data.nodes), edges: data.edges });
  } catch (err) { res.status(500).json({ error: `그래프 조회 실패: ${err.message}` }); }
});

// ── Taxonomy ─────────────────────────────────────────
app.get("/api/stations/:id/taxonomy", async (req, res) => {
  try {
    res.json(await loadTaxonomy(req.params.id));
  } catch { res.json({ topics: {} }); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  협의회(Council) 모드
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post("/api/council", async (req, res) => {
  try {
    const { question, stationIds } = req.body;
    if (!question) return res.status(400).json({ error: "question이 필요합니다." });
    const result = await runCouncil(question, stationIds || []);

    // 첫 Council 업적 체크
    const allStations = stationManager.getAll();
    for (const s of allStations) {
      if (!s.gamification.achievements.includes("first_council")) {
        s.gamification.achievements.push("first_council");
        await stationManager.updateGamification(s.id, s.gamification);
      }
    }

    res.json(result);
  } catch (err) {
    console.error("❌ 협의회 오류:", err);
    res.status(500).json({ error: `협의회 실행 실패: ${err.message}` });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  게이미피케이션 API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get("/api/stations/:id/gamification", (req, res) => {
  const station = stationManager.getById(req.params.id);
  if (!station) return res.status(404).json({ error: "스테이션을 찾을 수 없습니다." });
  res.json({
    ...station.gamification,
    progress: getLevelProgress(req.params.id),
    achievements: getAchievementList(req.params.id),
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  글로벌 통계
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get("/api/stats", (req, res) => {
  const stations = stationManager.getAll();
  const totalNotes = stations.reduce((s, st) => s + (st.stats.note_count || 0), 0);
  const totalQueries = stations.reduce((s, st) => s + (st.stats.query_count || 0), 0);
  const maxStreak = Math.max(0, ...stations.map(s => s.gamification.streak_days || 0));

  res.json({
    stationCount: stations.length,
    totalNotes,
    totalQueries,
    maxStreak,
    stations: stations.map(s => ({
      id: s.id, name: s.name, icon: s.icon,
      agentName: s.agent.name, agentAvatar: s.agent.avatar,
      level: s.gamification.level, xp: s.gamification.xp,
      noteCount: s.stats.note_count,
    })),
  });
});

// ── 에러 핸들링 + 서버 시작 ──────────────────────────
app.use((err, req, res, next) => {
  console.error("❌ 서버 오류:", err);
  res.status(500).json({ error: `서버 오류: ${err.message}` });
});

const PORT = process.env.PORT || 3456;

if (process.env.VERCEL === undefined) {
  // 로컬 모드: init() 완료 후 서버 시작
  ensureInit().then(() => {
    app.listen(PORT, () => {
      console.log(`\n🧠 BrainStation 서버 실행 중`);
      console.log(`   📍 http://localhost:${PORT}`);
      console.log(`   📡 스테이션: ${stationManager.getAll().length}개`);
      console.log(`   🎮 에이전트 프리셋: ${Object.keys(stationManager.AGENT_PRESETS).length}종\n`);
    });
  });
}

export default app;
