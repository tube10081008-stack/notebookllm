// server.js — BrainStation 2 (로컬 우선 지식 스테이션)
//
// 로컬 우선 선언 (ARCHITECTURE §1-⑤): 단일 프로세스가 워크스페이스를 소유한다.
// 외부 노출(터널·배포)은 AUTH_TOKEN 설정을 전제로 한 명시적 선택이다.
import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";

import { config } from "./src/config.js";
import { getLLM } from "./src/llm/index.js";
import * as ws from "./src/storage/workspace.js";
import * as stations from "./src/core/stations.js";
import { AGENT_PRESETS } from "./src/core/personas.js";
import { parseText, parseURL, parsePDF, parseYouTube, parseImage } from "./src/core/parsers.js";
import { ingest } from "./src/core/ingest.js";
import { retrieve, crossStationSearch } from "./src/core/retrieve.js";
import { synthesizeAnswer } from "./src/core/answer.js";
import { runCouncil } from "./src/core/council.js";
import { runGC } from "./src/core/gc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── 인증 (v1 문제 ⑥의 답) ────────────────────────────
// AUTH_TOKEN이 설정되면 /api/health를 제외한 모든 API에 Bearer 토큰을 요구한다.
app.use("/api", (req, res, next) => {
  if (req.path === "/health") return next();
  const token = config.server.authToken;
  if (!token) return next(); // 미설정 = localhost 개인 사용 모드
  const header = req.headers.authorization || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : req.headers["x-api-token"];
  if (provided === token) return next();
  return res.status(401).json({ error: "인증이 필요합니다. Authorization: Bearer <AUTH_TOKEN>" });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["application/pdf", "image/png", "image/jpeg", "image/jpg", "image/webp"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("PDF 또는 이미지 파일만 업로드 가능합니다."));
  },
});

// ── 헬스/시스템 정보 ─────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    version: "2.0.0",
    llm: getLLM().info(),
    workspace: ws.workspaceInfo(),
    authEnabled: !!config.server.authToken,
  });
});

// ── 프리셋 ───────────────────────────────────────────
app.get("/api/presets", (req, res) => {
  const presets = Object.entries(AGENT_PRESETS).map(([key, p]) => ({
    key, name: p.name, avatar: p.avatar, tone: p.tone,
    expertise: p.expertise, greeting: p.greeting, color: p.color,
  }));
  res.json({ presets });
});

// ── 스테이션 CRUD ────────────────────────────────────
app.get("/api/stations", async (req, res, next) => {
  try {
    const list = await stations.getAll();
    res.json({ stations: list.map((s) => ({ ...s, gamification: stations.gamificationView(s) })) });
  } catch (err) { next(err); }
});

app.post("/api/stations", async (req, res, next) => {
  try { res.json({ station: await stations.createStation(req.body || {}) }); }
  catch (err) { next(err); }
});

app.get("/api/stations/:id", async (req, res, next) => {
  try {
    const station = await stations.getById(req.params.id);
    if (!station) return res.status(404).json({ error: "스테이션을 찾을 수 없습니다." });
    res.json({ station: { ...station, gamification: stations.gamificationView(station) } });
  } catch (err) { next(err); }
});

app.put("/api/stations/:id", async (req, res, next) => {
  try {
    const station = await stations.updateStation(req.params.id, req.body || {});
    if (!station) return res.status(404).json({ error: "스테이션을 찾을 수 없습니다." });
    res.json({ station });
  } catch (err) { next(err); }
});

app.delete("/api/stations/:id", async (req, res, next) => {
  try {
    const ok = await stations.deleteStation(req.params.id);
    if (!ok) return res.status(404).json({ error: "스테이션을 찾을 수 없습니다." });
    res.json({ message: "스테이션이 목록에서 제거되었습니다. 데이터 디렉토리는 보존됩니다 (불변식 5)." });
  } catch (err) { next(err); }
});

// ── 수집 (Ingest) ────────────────────────────────────
app.post("/api/stations/:id/ingest", upload.single("file"), async (req, res, next) => {
  try {
    const station = await stations.getById(req.params.id);
    if (!station) return res.status(404).json({ error: "스테이션을 찾을 수 없습니다." });

    let parsed;
    if (req.file) {
      const filename = Buffer.from(req.file.originalname, "latin1").toString("utf8");
      parsed = req.file.mimetype.startsWith("image/")
        ? await parseImage(req.file.buffer, filename, req.file.mimetype)
        : await parsePDF(req.file.buffer, filename);
    } else {
      const { type, content } = req.body || {};
      if (!type || !content) return res.status(400).json({ error: "type과 content가 필요합니다." });
      switch (type) {
        case "text": parsed = parseText(content); break;
        case "url": parsed = await parseURL(content); break;
        case "youtube": parsed = await parseYouTube(content); break;
        default: return res.status(400).json({ error: `지원하지 않는 type: ${type}` });
      }
    }

    const { notes, edges } = await ingest(station, parsed);

    await stations.bumpStats(station.id, { source_count: 1, note_count: notes.length });
    await stations.grantXP(station.id, "source_added");
    let xp = null;
    for (const _ of notes) xp = await stations.grantXP(station.id, "note_created");

    res.json({
      message: `${station.agent.name}이(가) ${notes.length}개의 노트와 ${edges}개의 연결을 만들었습니다.`,
      notes,
      edges,
      xp,
    });
  } catch (err) { next(err); }
});

// ── 질의 (Query) ─────────────────────────────────────
app.post("/api/stations/:id/query", async (req, res, next) => {
  try {
    const station = await stations.getById(req.params.id);
    if (!station) return res.status(404).json({ error: "스테이션을 찾을 수 없습니다." });

    const { question } = req.body || {};
    if (!question) return res.status(400).json({ error: "question이 필요합니다." });

    const { ranked, qEmbed, behavior } = await retrieve(station.id, question, station.agent);
    const result = await synthesizeAnswer({ sid: station.id, station, question, ranked, behavior });

    let crossRecommendations = [];
    try {
      const all = await stations.getAll();
      crossRecommendations = await crossStationSearch(qEmbed, all, station.id);
    } catch { /* 추천 실패는 답변을 막지 않는다 */ }

    await stations.bumpStats(station.id, { query_count: 1 });
    const xp = await stations.grantXP(station.id, "query_asked");

    // 대화 영구 아카이브 (append-only) + 감사 이벤트
    await ws.appendChat(station.id, {
      timestamp: new Date().toISOString(),
      question,
      answer: result.answer,
      confidence: result.confidence,
      citations: result.citations,
    });
    await ws.appendEvent(station.id, "query", { question: question.slice(0, 200), notesUsed: result.notesUsed });

    res.json({
      ...result,
      crossRecommendations: crossRecommendations.slice(0, 3),
      agentName: station.agent.name,
      agentAvatar: station.agent.avatar,
      xp,
    });
  } catch (err) {
    if (err.code === "EMBED_MODEL_MISMATCH") return res.status(409).json({ error: err.message });
    next(err);
  }
});

// ── 대화/노트/그래프/이벤트 조회 ─────────────────────
app.get("/api/stations/:id/chats", async (req, res, next) => {
  try { res.json({ chats: await ws.loadChats(req.params.id) }); }
  catch (err) { next(err); }
});

app.get("/api/stations/:id/notes", async (req, res, next) => {
  try {
    let notes = await ws.loadAllNotes(req.params.id);
    const { search, topic, archived } = req.query;
    if (archived !== "true" && archived !== "all") notes = notes.filter((n) => !n.archived);
    if (topic) notes = notes.filter((n) => n.topics?.includes(topic));
    if (search) {
      const q = String(search).toLowerCase();
      notes = notes.filter((n) => n.title?.toLowerCase().includes(q) || n.content?.toLowerCase().includes(q));
    }
    notes.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({
      total: notes.length,
      notes: notes.map((n) => ({
        id: n.id, title: n.title, type: n.type, topics: n.topics,
        confidence: n.confidence, half_life: n.half_life, my_take: n.my_take,
        created_at: n.created_at, archived: n.archived, source: n.source,
        contentPreview: (n.content || "").slice(0, 200),
      })),
    });
  } catch (err) { next(err); }
});

app.get("/api/stations/:id/notes/:noteId", async (req, res, next) => {
  try {
    const note = await ws.loadNote(req.params.id, req.params.noteId);
    if (!note) return res.status(404).json({ error: "노트를 찾을 수 없습니다." });
    // 이 노트와 연결된 엣지 + 상대 노트 제목 (그래프 시각화 대신 연결 목록 — ARCHITECTURE §8)
    const graph = await ws.loadGraph(req.params.id);
    const links = [];
    for (const e of graph.edges) {
      const otherId = e.source === note.id ? e.target : e.target === note.id ? e.source : null;
      if (!otherId) continue;
      const other = await ws.loadNote(req.params.id, otherId);
      links.push({ noteId: otherId, title: other?.title || otherId, relation: e.relation, direction: e.source === note.id ? "out" : "in" });
    }
    res.json({ ...note, graph_links: links });
  } catch (err) { next(err); }
});

app.put("/api/stations/:id/notes/:noteId", async (req, res, next) => {
  try {
    const sid = req.params.id;
    const note = await ws.loadNote(sid, req.params.noteId);
    if (!note) return res.status(404).json({ error: "노트를 찾을 수 없습니다." });

    const updatable = ["my_take", "title", "content", "type", "topics", "half_life", "confidence", "archived"];
    const changed = [];
    for (const k of updatable) {
      if (req.body[k] !== undefined) { note[k] = req.body[k]; changed.push(k); }
    }
    note.updated_at = new Date().toISOString();
    await ws.saveNote(sid, note);
    await ws.appendEvent(sid, "note.updated", { note_id: note.id, fields: changed });

    let xp = null;
    if (req.body.my_take && req.body.my_take.length > 0) xp = await stations.grantXP(sid, "my_take_written");
    res.json({ message: "노트가 수정되었습니다.", note, xp });
  } catch (err) { next(err); }
});

app.delete("/api/stations/:id/notes/:noteId", async (req, res, next) => {
  try {
    const sid = req.params.id;
    const nid = req.params.noteId;
    await ws.deleteNote(sid, nid);
    await ws.deleteVector(sid, nid);
    const graph = await ws.loadGraph(sid);
    graph.edges = graph.edges.filter((e) => e.source !== nid && e.target !== nid);
    await ws.saveGraph(sid, graph);
    await ws.appendEvent(sid, "note.deleted", { note_id: nid, by: "user" });
    res.json({ message: "노트가 삭제되었습니다. (원문 raw는 보존됩니다)" });
  } catch (err) { next(err); }
});

app.get("/api/stations/:id/graph", async (req, res, next) => {
  try {
    const [graph, notes] = await Promise.all([ws.loadGraph(req.params.id), ws.loadAllNotes(req.params.id)]);
    res.json({
      nodes: notes.map((n) => ({ id: n.id, title: n.title, type: n.type, topics: n.topics, archived: n.archived })),
      edges: graph.edges,
    });
  } catch (err) { next(err); }
});

app.get("/api/stations/:id/events", async (req, res, next) => {
  try { res.json({ events: await ws.loadEvents(req.params.id, Number(req.query.limit || 100)) }); }
  catch (err) { next(err); }
});

// ── 협의회 / GC / 통계 ───────────────────────────────
app.post("/api/council", async (req, res, next) => {
  try {
    const { question, stationIds } = req.body || {};
    if (!question) return res.status(400).json({ error: "question이 필요합니다." });
    res.json(await runCouncil(question, stationIds || []));
  } catch (err) { next(err); }
});

app.post("/api/stations/:id/gc", async (req, res, next) => {
  try {
    const station = await stations.getById(req.params.id);
    if (!station) return res.status(404).json({ error: "스테이션을 찾을 수 없습니다." });
    res.json(await runGC(req.params.id));
  } catch (err) { next(err); }
});

app.get("/api/stats", async (req, res, next) => {
  try {
    const list = await stations.getAll();
    res.json({
      stationCount: list.length,
      totalNotes: list.reduce((s, st) => s + (st.stats.note_count || 0), 0),
      totalQueries: list.reduce((s, st) => s + (st.stats.query_count || 0), 0),
      stations: list.map((s) => ({
        id: s.id, name: s.name, icon: s.icon,
        agentName: s.agent.name, agentAvatar: s.agent.avatar,
        ...stations.gamificationView(s),
        noteCount: s.stats.note_count,
      })),
    });
  } catch (err) { next(err); }
});

// ── 에러 핸들러 ──────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("❌ 서버 오류:", err);
  res.status(500).json({ error: `서버 오류: ${err.message}` });
});

// ── 시작 ─────────────────────────────────────────────
const { port, host } = config.server;
app.listen(port, host, () => {
  const info = getLLM().info();
  console.log(`\n🧠 BrainStation 2 실행 중`);
  console.log(`   📍 http://${host}:${port}`);
  console.log(`   🤖 LLM provider: ${info.provider} (text: ${info.textModel}, embed: ${info.embedModel})`);
  console.log(`   📂 워크스페이스: ${ws.workspaceInfo().root}`);
  console.log(`   🔐 인증: ${config.server.authToken ? "활성" : "비활성 (localhost 전용 권장)"}\n`);
});

export default app;
