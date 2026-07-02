// scripts/import-agents.js — 에이전트 뇌 데이터를 Second Brain으로 임포트
import { readFile, readdir, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

import { embedText, embedBatch } from "../lib/gemini.js";
import * as vectorStore from "../lib/vector-store.js";
import * as graph from "../lib/graph.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── 경로 설정 ────────────────────────────────────────
// 에이전트 뇌 데이터 소스 (환경변수로 오버라이드 가능)
const BRAIN_DIR = process.env.BRAIN_SOURCE_DIR
  || path.resolve("c:/Users/tube1/Projects/여행 렌탈 비즈니스/_brain");
const NOTES_DIR = path.resolve(__dirname, "../data/notes");
const TAXONOMY_PATH = path.resolve(__dirname, "../data/taxonomy.json");

const AGENTS = ["hani", "geo", "noah", "lina", "alex"];
const SUBFOLDERS = ["facts", "lessons", "preferences", "directives", "shared"];

// ── memory_type → note type 매핑 ────────────────────
const TYPE_MAP = {
  fact: "fact",
  lesson: "concept",
  directive: "procedure",
  preference: "opinion",
  context: "temporal",
  shared: "fact",
  shared_knowledge: "fact",
};

// ── 에이전트 이름 한국어 매핑 ────────────────────────
const AGENT_NAMES = {
  hani: "하니",
  geo: "지오",
  noah: "노아",
  lina: "리나",
  alex: "알렉스",
};

// ── YAML frontmatter 파서 (간단 버전) ────────────────
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const yamlStr = match[1];
  const body = match[2].trim();
  const frontmatter = {};

  for (const line of yamlStr.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // 배열 값 처리: [tag1, tag2]
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }
    // 따옴표 제거
    else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // 숫자
    else if (!isNaN(value) && value !== "") {
      value = Number(value);
    }
    // boolean
    else if (value === "true") value = true;
    else if (value === "false") value = false;

    frontmatter[key] = value;
  }

  return { frontmatter, body };
}

// ── 본문에서 핵심 요약 추출 ──────────────────────────
function extractSummary(body) {
  // "📌 핵심 요약" 또는 "📌 공유 내용" 다음의 인용문(>) 추출
  const summaryMatch = body.match(
    /(?:핵심 요약|공유 내용)\s*\n>\s*([\s\S]*?)(?:\n\n|\n##|$)/,
  );
  if (summaryMatch) {
    return summaryMatch[1]
      .replace(/^>\s*/gm, "")
      .trim();
  }

  // 인용문(blockquote) 추출
  const blockquoteMatch = body.match(/^>\s*([\s\S]*?)(?:\n\n|$)/m);
  if (blockquoteMatch) {
    return blockquoteMatch[1]
      .replace(/^>\s*/gm, "")
      .trim();
  }

  // 첫 번째 의미 있는 줄 반환
  const lines = body.split("\n").filter(
    (l) => l.trim() && !l.startsWith("#") && !l.startsWith("-"),
  );
  return lines[0] || body.slice(0, 200);
}

// ── 단일 .md 파일 임포트 ─────────────────────────────
async function importFile(filePath, agentId, subfolder) {
  const raw = await readFile(filePath, "utf-8");
  const { frontmatter, body } = parseFrontmatter(raw);

  const memoryType = frontmatter.memory_type || frontmatter.type || subfolder;
  const noteType = TYPE_MAP[memoryType] || TYPE_MAP[subfolder] || "fact";

  const summary = extractSummary(body);
  const title = (frontmatter.title || path.basename(filePath, ".md"))
    .replace(/^\[\[/, "")
    .replace(/\]\]$/, "")
    .replace(/^💌\s*/, "");

  const note = {
    id: frontmatter.id || `imported_${agentId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title,
    content: summary,
    my_take: "",
    why_saved: `에이전트 뇌에서 임포트 (${AGENT_NAMES[agentId] || agentId})`,
    type: noteType,
    topics: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
    half_life: noteType === "opinion" ? "6mo" : "permanent",
    confidence: frontmatter.confidence_score ?? 0.9,
    conditions: [],
    implications: [],
    source: {
      title: `에이전트 뇌: ${AGENT_NAMES[agentId] || agentId}`,
      url: "",
      author: AGENT_NAMES[agentId] || agentId,
      date: frontmatter.created_at || frontmatter.updated_at || new Date().toISOString(),
    },
    links: [],
    created_at: frontmatter.created_at || new Date().toISOString(),
    last_accessed: new Date().toISOString(),
    access_count: frontmatter.reinforce_count || 0,
    archived: frontmatter.status === "archived",
    _agent_id: agentId,
    _memory_type: memoryType,
    _importance: frontmatter.importance,
  };

  return note;
}

// ── 메인 임포트 실행 ─────────────────────────────────
async function main() {
  console.log("🧠 에이전트 뇌 데이터 → Second Brain 임포트 시작\n");
  console.log(`📁 소스: ${BRAIN_DIR}`);
  console.log(`📁 대상: ${NOTES_DIR}\n`);

  // 데이터 디렉토리 생성
  await mkdir(NOTES_DIR, { recursive: true });
  await mkdir(path.dirname(TAXONOMY_PATH), { recursive: true });

  // 저장소 초기화
  await vectorStore.init();
  await graph.init();

  const allNotes = [];
  const stats = {
    total: 0,
    byAgent: {},
    byType: {},
    errors: 0,
  };

  // ── 에이전트별 파일 수집 ────────────────────────────
  for (const agent of AGENTS) {
    stats.byAgent[agent] = 0;
    const agentDir = path.join(BRAIN_DIR, agent);

    if (!existsSync(agentDir)) {
      console.log(`⚠️ ${AGENT_NAMES[agent]} 디렉토리 없음: ${agentDir}`);
      continue;
    }

    for (const sub of SUBFOLDERS) {
      const subDir = path.join(agentDir, sub);
      if (!existsSync(subDir)) continue;

      let files;
      try {
        files = await readdir(subDir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith(".md")) continue;

        try {
          const note = await importFile(
            path.join(subDir, file),
            agent,
            sub,
          );
          allNotes.push(note);
          stats.byAgent[agent]++;
          stats.byType[note.type] = (stats.byType[note.type] || 0) + 1;
        } catch (err) {
          console.error(
            `  ❌ ${agent}/${sub}/${file}: ${err.message}`,
          );
          stats.errors++;
        }
      }
    }

    console.log(
      `  ✅ ${AGENT_NAMES[agent]}: ${stats.byAgent[agent]}개 수집`,
    );
  }

  // ── 공유 지식 (_shared/) 수집 ──────────────────────
  const sharedDir = path.join(BRAIN_DIR, "_shared");
  let sharedCount = 0;
  if (existsSync(sharedDir)) {
    const files = await readdir(sharedDir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;

      try {
        // 발신자 추출 (파일명 패턴: agent-to-...)
        const agentMatch = file.match(/^(hani|geo|noah|lina|alex)-to/);
        const agentId = agentMatch ? agentMatch[1] : "shared";

        const note = await importFile(
          path.join(sharedDir, file),
          agentId,
          "shared",
        );
        note.source.title = `에이전트 공유 지식`;
        allNotes.push(note);
        sharedCount++;
      } catch (err) {
        console.error(`  ❌ _shared/${file}: ${err.message}`);
        stats.errors++;
      }
    }
    console.log(`  ✅ 공유 지식: ${sharedCount}개 수집`);
  }

  stats.total = allNotes.length;
  console.log(`\n📊 총 ${stats.total}개 노트 수집 완료\n`);

  // ── 중복 ID 처리 ───────────────────────────────────
  const idSet = new Set();
  for (const note of allNotes) {
    if (idSet.has(note.id)) {
      note.id = `${note.id}_dup_${Math.random().toString(36).slice(2, 6)}`;
    }
    idSet.add(note.id);
  }

  // ── 임베딩 생성 (배치) ─────────────────────────────
  console.log("🔮 임베딩 생성 중...");
  const BATCH_SIZE = 20;
  for (let i = 0; i < allNotes.length; i += BATCH_SIZE) {
    const batch = allNotes.slice(i, i + BATCH_SIZE);
    const texts = batch.map((n) => `${n.title} ${n.content}`);

    try {
      const embeddings = await embedBatch(texts);
      for (let j = 0; j < batch.length; j++) {
        batch[j]._embedding = embeddings[j];
      }
      process.stdout.write(
        `  ${Math.min(i + BATCH_SIZE, allNotes.length)}/${allNotes.length} 완료\r`,
      );
    } catch (err) {
      console.error(`\n  ❌ 배치 ${i}~${i + BATCH_SIZE} 임베딩 실패:`, err.message);
      // 실패한 배치는 개별로 시도
      for (const note of batch) {
        try {
          note._embedding = await embedText(`${note.title} ${note.content}`);
        } catch {
          console.error(`  ❌ 개별 임베딩 실패: ${note.title}`);
          note._embedding = null;
        }
      }
    }
  }
  console.log("\n✅ 임베딩 생성 완료\n");

  // ── 저장소에 저장 ──────────────────────────────────
  console.log("💾 저장소에 저장 중...");

  const topicCounts = {};

  for (const note of allNotes) {
    // 벡터 저장소
    if (note._embedding) {
      await vectorStore.addVector(note.id, note._embedding, {
        title: note.title,
        type: note.type,
      });
    }

    // 그래프 노드
    graph.addNode(note);

    // 토픽 집계
    for (const topic of note.topics) {
      topicCounts[topic] = (topicCounts[topic] || 0) + 1;
    }

    // 임베딩 데이터는 노트 파일에 저장하지 않음
    const { _embedding, _agent_id, _memory_type, _importance, ...noteData } =
      note;

    // 노트 파일 저장
    await writeFile(
      path.join(NOTES_DIR, `${note.id}.json`),
      JSON.stringify(noteData, null, 2),
      "utf-8",
    );
  }

  // ── 같은 에이전트 노트 간 엣지 추가 ───────────────
  console.log("🔗 에이전트 내 지식 연결 중...");
  const byAgent = {};
  for (const note of allNotes) {
    const aid = note._agent_id || "unknown";
    if (!byAgent[aid]) byAgent[aid] = [];
    byAgent[aid].push(note);
  }

  for (const [agent, notes] of Object.entries(byAgent)) {
    // 같은 에이전트의 노트들은 same_agent 관계로 연결
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        // 같은 토픽을 공유하는 노트끼리만 연결
        const commonTopics = notes[i].topics.filter((t) =>
          notes[j].topics.includes(t),
        );
        if (commonTopics.length > 0) {
          graph.addEdge(
            notes[i].id,
            notes[j].id,
            "related_to",
            0.5 + commonTopics.length * 0.1,
          );
        }
      }
    }
  }

  // ── Taxonomy 저장 ──────────────────────────────────
  const taxonomy = {
    topics: topicCounts,
    updated_at: new Date().toISOString(),
  };
  await writeFile(TAXONOMY_PATH, JSON.stringify(taxonomy, null, 2), "utf-8");

  // ── 저장소 최종 저장 ───────────────────────────────
  await vectorStore.save();
  await graph.save();

  // ── 결과 요약 ──────────────────────────────────────
  const graphStats = graph.getStats();

  console.log("\n" + "═".repeat(50));
  console.log("🧠 Second Brain 임포트 완료!");
  console.log("═".repeat(50));
  console.log(`\n📊 임포트 요약:`);
  console.log(`   총 노트: ${stats.total}개`);
  console.log(`   에러: ${stats.errors}개`);
  console.log(`\n👥 에이전트별:`);
  for (const [agent, count] of Object.entries(stats.byAgent)) {
    console.log(`   ${AGENT_NAMES[agent] || agent}: ${count}개`);
  }
  console.log(`   공유 지식: ${sharedCount}개`);
  console.log(`\n📝 타입별:`);
  for (const [type, count] of Object.entries(stats.byType)) {
    console.log(`   ${type}: ${count}개`);
  }
  console.log(`\n🕸️ 그래프:`);
  console.log(`   노드: ${graphStats.nodeCount}개`);
  console.log(`   엣지: ${graphStats.edgeCount}개`);
  console.log(`   평균 연결: ${graphStats.avgConnections}`);
  console.log(`\n📦 벡터 저장소: ${vectorStore.count()}개`);
  console.log(`\n🏷️ 토픽: ${Object.keys(topicCounts).length}종`);
  console.log("═".repeat(50) + "\n");
}

main().catch((err) => {
  console.error("❌ 임포트 실패:", err);
  process.exit(1);
});
