// server.js — BrainStation 3 (로컬 우선 지식 스테이션)
//
// 로컬 우선 선언 (ARCHITECTURE §1-⑤): 단일 프로세스가 워크스페이스를 소유한다.
// 외부 노출(터널·배포)은 AUTH_TOKEN 설정을 전제로 한 명시적 선택이다.
import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";

import { config, isPersistent } from "./src/config.js";
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
import { getCharter, updateCharter, recordRejection, sanitizeCharterInput, defaultCharter } from "./src/core/charter.js";
import { runScout } from "./src/core/scout.js";
import { synthesizeAgent } from "./src/core/agentsmith.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── 인증 (v1 문제 ⑥의 답) ────────────────────────────
// AUTH_TOKEN이 설정되면 /api/health를 제외한 모든 API에 Bearer 토큰을 요구한다.
// 서버리스(공개 URL)에서는 AUTH_TOKEN이 없으면 API를 아예 열지 않는다 —
// v1이 인증 없이 공개 배포되어 노트·대화가 전부 노출됐던 사고의 재발 방지.
app.use("/api", (req, res, next) => {
  if (req.path === "/health") return next();
  const token = config.server.authToken;
  if (!token) {
    if (config.serverless) {
      return res.status(503).json({
        error: "공개 배포에서는 AUTH_TOKEN 없이 API를 열 수 없습니다. " +
               "Vercel 프로젝트 설정 → Environment Variables에 AUTH_TOKEN을 추가한 뒤 재배포하세요.",
      });
    }
    return next(); // 미설정 = localhost 개인 사용 모드
  }
  const header = req.headers.authorization || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : req.headers["x-api-token"];
  if (provided === token) return next();
  return res.status(401).json({ error: "인증이 필요합니다. Authorization: Bearer <AUTH_TOKEN>" });
});

// 서버리스(Vercel)는 요청 본문을 ~4.5MB에서 플랫폼이 차단하므로,
// 우리 한도를 그 아래(4MB)로 잡아 친절한 에러라도 우리가 낼 수 있게 한다.
const MAX_UPLOAD = config.serverless ? 4 * 1024 * 1024 : 20 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD },
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
    version: "3.0.0",
    llm: getLLM().info(),
    workspace: ws.workspaceInfo(),
    authEnabled: !!config.server.authToken,
    // 서버리스 + filesystem = 미리보기 / 서버리스 + github = 영속 (하이브리드)
    runtime: config.serverless
      ? (config.storageBackend === "github" ? "serverless-github" : "serverless-preview")
      : "local",
    persistent: isPersistent(),
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
  try {
    const body = req.body || {};

    // 에이전트 = 헌장의 파생물: 설문에 방향이 있으면 전담 에이전트를 합성한다.
    // (customAgent가 명시되면 사용자의 선택이 우선 — 프리셋은 폴백 안전망)
    let customAgent = body.customAgent || null;
    const charterInput = body.charter ? { ...defaultCharter(), ...sanitizeCharterInput(body.charter) } : null;
    if (!customAgent && charterInput) {
      const agent = await synthesizeAgent(charterInput);
      if (agent.synthesized) customAgent = agent;
    }

    const station = await stations.createStation({ ...body, customAgent });
    let charter = null;
    if (body.charter) charter = await updateCharter(station.id, body.charter);
    res.json({ station, charter });
  } catch (err) { next(err); }
});

// ── 명부 복구 (비상 도구): 사라진 스테이션을 git 히스토리·디렉토리에서 되찾는다 ──
app.post("/api/stations/repair", async (req, res, next) => {
  try {
    const result = await stations.repairStations(synthesizeAgent);
    res.json({
      ...result,
      message: result.recovered.length > 0
        ? `${result.recovered.length}개 스테이션 복구: ${result.recovered.map((r) => r.name).join(", ")}`
        : "복구할 스테이션이 없습니다 — 명부가 온전합니다.",
    });
  } catch (err) { next(err); }
});

// ── 에이전트 재조율 — 헌장·축적 데이터에서 에이전트를 다시 파생 ──
app.post("/api/stations/:id/agent/retune", async (req, res, next) => {
  try {
    const station = await stations.getById(req.params.id);
    if (!station) return res.status(404).json({ error: "스테이션을 찾을 수 없습니다." });

    const charter = await getCharter(station.id);
    const notes = await ws.loadAllNotes(station.id);
    const topicCounts = {};
    for (const n of notes) for (const t of n.topics || []) topicCounts[t] = (topicCounts[t] || 0) + 1;
    const rejections = (charter.learned || []).map((l) => l.reason).filter(Boolean);

    const agent = await synthesizeAgent(charter, { topicCounts, rejections });
    if (!agent.synthesized) {
      return res.status(400).json({ error: "헌장에 목적/토픽이 없어 합성할 재료가 없습니다. 먼저 헌장을 작성하세요." });
    }

    const updated = await stations.updateStation(station.id, { agent, color: agent.color, icon: agent.avatar });
    await ws.appendEvent(station.id, "agent.retuned", {
      name: agent.name, personality: agent.personality,
      basis: { topics: Object.keys(topicCounts).length, rejections: rejections.length },
    });
    res.json({ station: updated, agent, message: `${agent.avatar} ${agent.name}(${agent.personality})으로 재조율되었습니다.` });
  } catch (err) { next(err); }
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

    // 자료 유형: reference(목록·표 원문 보존) | concept(기본, 개념 증류)
    const mode = (req.body?.mode === "reference") ? "reference" : "concept";
    const { notes, edges } = await ingest(station, parsed, { mode });

    await stations.bumpStats(station.id, { source_count: 1, note_count: notes.length });
    await stations.grantXP(station.id, "source_added");
    let xp = null;
    for (const _ of notes) xp = await stations.grantXP(station.id, "note_created");

    const msg = mode === "reference"
      ? `${station.agent.name}이(가) 원문을 ${notes.length}개 조각으로 보존했습니다 (검색 가능).`
      : `${station.agent.name}이(가) ${notes.length}개의 노트와 ${edges}개의 연결을 만들었습니다.`;
    res.json({ message: msg, notes, edges, mode, xp });
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
    await ws.appendEvent(station.id, "query", { question: question.slice(0, 200), notesUsed: result.notesUsed, blended: result.blended });

    // 답변이 드러낸 지식 결핍은 Scout의 수요 신호가 된다 (결핍 주도 수집)
    if (Array.isArray(result.gaps) && result.gaps.length > 0) {
      await ws.appendGaps(station.id, result.gaps.slice(0, 5), question);
    }

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

// ── 지식 헌장 (Charter) ──────────────────────────────
app.get("/api/stations/:id/charter", async (req, res, next) => {
  try { res.json({ charter: await getCharter(req.params.id) }); }
  catch (err) { next(err); }
});

app.put("/api/stations/:id/charter", async (req, res, next) => {
  try {
    const station = await stations.getById(req.params.id);
    if (!station) return res.status(404).json({ error: "스테이션을 찾을 수 없습니다." });
    res.json({ charter: await updateCharter(req.params.id, req.body || {}) });
  } catch (err) { next(err); }
});

// ── 스카우트 (자동 제안 — 절대 자동 ingest 아님) ─────
app.post("/api/stations/:id/scout", async (req, res, next) => {
  try {
    const station = await stations.getById(req.params.id);
    if (!station) return res.status(404).json({ error: "스테이션을 찾을 수 없습니다." });
    res.json(await runScout(req.params.id));
  } catch (err) { next(err); }
});

// ── 수집함 (Inbox) — 인간의 승인 게이트 ──────────────
app.get("/api/stations/:id/inbox", async (req, res, next) => {
  try {
    const inbox = await ws.loadInbox(req.params.id);
    const pending = inbox.items.filter((i) => i.status === "pending");
    const history = inbox.items.filter((i) => i.status !== "pending").slice(-30);
    res.json({ pending, history, total: inbox.items.length });
  } catch (err) { next(err); }
});

app.post("/api/stations/:id/inbox/:itemId/accept", async (req, res, next) => {
  try {
    const station = await stations.getById(req.params.id);
    if (!station) return res.status(404).json({ error: "스테이션을 찾을 수 없습니다." });

    const inbox = await ws.loadInbox(station.id);
    const item = inbox.items.find((i) => i.id === req.params.itemId && i.status === "pending");
    if (!item) return res.status(404).json({ error: "대기 중인 제안을 찾을 수 없습니다." });

    // 승인 → 그제서야 ingest (원문 보존 → 증류 → 임베딩 → 그래프)
    const isYouTube = /youtube\.com|youtu\.be/.test(item.url);
    const parsed = isYouTube ? await parseYouTube(item.url) : await parseURL(item.url);
    const { notes, edges } = await ingest(station, parsed);

    item.status = "accepted";
    item.resolved_at = new Date().toISOString();
    await ws.saveInbox(station.id, inbox);
    await ws.appendEvent(station.id, "inbox.accepted", { url: item.url, title: item.title, notes: notes.length });

    await stations.bumpStats(station.id, { source_count: 1, note_count: notes.length });
    await stations.grantXP(station.id, "source_added");

    res.json({ message: `승인 → ${notes.length}개 노트, ${edges}개 연결 생성`, notes, edges });
  } catch (err) { next(err); }
});

app.post("/api/stations/:id/inbox/:itemId/reject", async (req, res, next) => {
  try {
    const inbox = await ws.loadInbox(req.params.id);
    const item = inbox.items.find((i) => i.id === req.params.itemId && i.status === "pending");
    if (!item) return res.status(404).json({ error: "대기 중인 제안을 찾을 수 없습니다." });

    item.status = "rejected";
    item.reject_reason = (req.body?.reason || "").slice(0, 300);
    item.resolved_at = new Date().toISOString();
    await ws.saveInbox(req.params.id, inbox);

    // 거절 사유는 헌장에 학습된다 — 미래 수집을 바꾸는 정책 신호
    await recordRejection(req.params.id, { url: item.url, title: item.title, reason: item.reject_reason });
    await ws.appendEvent(req.params.id, "inbox.rejected", { url: item.url, reason: item.reject_reason });

    res.json({ message: "거절되었습니다. 사유가 헌장에 학습되었습니다." });
  } catch (err) { next(err); }
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
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      error: `파일이 너무 큽니다 (최대 ${Math.round(MAX_UPLOAD / 1024 / 1024)}MB). ` +
             (config.serverless ? "큰 PDF는 로컬 실행(npm run dev)에서 수집하거나 챕터별로 나눠서 올려주세요." : "파일을 나눠서 올려주세요."),
    });
  }
  console.error("❌ 서버 오류:", err);
  res.status(500).json({ error: `서버 오류: ${err.message}` });
});

// ── 시작 ─────────────────────────────────────────────
// 서버리스에서는 플랫폼이 핸들러를 호출하므로 listen하지 않는다.
if (!config.serverless) {
  const { port, host } = config.server;
  app.listen(port, host, () => {
    const info = getLLM().info();
    console.log(`\n🧠 BrainStation 3 실행 중`);
    console.log(`   📍 http://${host}:${port}`);
    console.log(`   🤖 LLM provider: ${info.provider} (text: ${info.textModel}, embed: ${info.embedModel})`);
    console.log(`   📂 워크스페이스: ${ws.workspaceInfo().root}`);
    console.log(`   🔐 인증: ${config.server.authToken ? "활성" : "비활성 (localhost 전용 권장)"}\n`);
  });
}

export default app;
