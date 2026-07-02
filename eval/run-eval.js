// eval/run-eval.js — 검색 품질 실측 (LLM-free)
//
// claudeWIKI rag-poc의 방법론 이식: "느낌이 아니라 숫자로."
// 랭킹 가중치·그래프 확장·페르소나 검색 설정을 바꿀 때마다 이 스크립트로 회귀를 확인한다.
// (실측 교훈: 더미 dense가 섞인 하이브리드는 BM25 단독보다 나빴다 — 측정 없는 개선은 개악일 수 있다)
//
// 골든셋 형식 (eval/golden.jsonl — gitignore됨. 예시는 golden.example.jsonl):
//   {"station":"<스테이션 ID>","question":"...","expect_ids":["noteId"...]}          — ID로 정답 지정
//   {"station":"<스테이션 ID>","question":"...","expect_titles":["제목 부분문자열"...]} — 제목으로 정답 지정
//
// 사용: npm run eval  (질문 임베딩에만 LLM 호출. 답변 생성은 하지 않는다)
import path from "path";
import { fileURLToPath } from "url";
import { readFile, mkdir, writeFile } from "fs/promises";
import { getLLM } from "../src/llm/index.js";
import * as ws from "../src/storage/workspace.js";
import * as stationsCore from "../src/core/stations.js";
import { rankCandidates, assertEmbeddingCompatible } from "../src/core/retrieve.js";
import { getAgentBehavior } from "../src/core/personas.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = process.argv[2] || path.join(__dirname, "golden.jsonl");
const K = 5;

function isHit(entry, note) {
  if (entry.expect_ids?.includes(note.id)) return true;
  if (entry.expect_titles?.some((t) => (note.title || "").includes(t))) return true;
  return false;
}

async function main() {
  let raw;
  try {
    raw = await readFile(GOLDEN, "utf-8");
  } catch {
    console.error(`골든셋이 없습니다: ${GOLDEN}`);
    console.error(`eval/golden.example.jsonl을 참고해 eval/golden.jsonl을 만드세요.`);
    process.exit(1);
  }
  const entries = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  console.log(`📏 골든셋 ${entries.length}개 로드 (${GOLDEN})`);
  console.log(`🤖 임베딩: ${getLLM().info().embedModel}\n`);

  let hit1 = 0, recallK = 0, mrrSum = 0, skipped = 0;
  const failures = [];

  for (const entry of entries) {
    const station = await stationsCore.getById(entry.station);
    if (!station) { skipped++; continue; }

    const vectorStore = await ws.loadVectors(station.id);
    try { assertEmbeddingCompatible(vectorStore); }
    catch (err) { console.error(err.message); process.exit(1); }

    const [qEmbed, allNotes, graph] = await Promise.all([
      getLLM().embedOne(entry.question),
      ws.loadAllNotes(station.id),
      ws.loadGraph(station.id),
    ]);
    const notesById = new Map(allNotes.map((n) => [n.id, n]));
    const behavior = getAgentBehavior(station.agent?.personality);
    const ranked = rankCandidates({ qEmbed, vectorStore, graph, notesById, behavior });

    const topK = ranked.slice(0, K);
    const hitAt1 = topK.length > 0 && isHit(entry, topK[0].note);
    const hitInK = topK.some((r) => isHit(entry, r.note));
    const rank = topK.findIndex((r) => isHit(entry, r.note));

    if (hitAt1) hit1++;
    if (hitInK) recallK++;
    mrrSum += rank >= 0 ? 1 / (rank + 1) : 0;
    if (!hitInK) {
      failures.push({
        question: entry.question,
        expected: entry.expect_titles || entry.expect_ids,
        got: topK.map((r) => r.note.title),
      });
    }
  }

  const n = entries.length - skipped;
  if (n === 0) { console.error("평가 가능한 항목이 없습니다."); process.exit(1); }

  const report = {
    timestamp: new Date().toISOString(),
    golden: GOLDEN,
    embedModel: getLLM().info().embedModel,
    n,
    skipped,
    metrics: {
      [`hit@1`]: +(hit1 / n).toFixed(4),
      [`recall@${K}`]: +(recallK / n).toFixed(4),
      mrr: +(mrrSum / n).toFixed(4),
    },
    failures,
  };

  console.log(`── 결과 (n=${n}${skipped ? `, 스킵 ${skipped}` : ""}) ──`);
  console.log(`  Hit@1     : ${(report.metrics["hit@1"] * 100).toFixed(1)}%`);
  console.log(`  Recall@${K}  : ${(report.metrics[`recall@${K}`] * 100).toFixed(1)}%`);
  console.log(`  MRR       : ${report.metrics.mrr.toFixed(3)}`);
  if (failures.length) {
    console.log(`\n── 실패 ${failures.length}건 ──`);
    for (const f of failures.slice(0, 10)) {
      console.log(`  Q: ${f.question}\n     기대: ${JSON.stringify(f.expected)}\n     결과: ${JSON.stringify(f.got.slice(0, 3))}`);
    }
  }

  const reportsDir = path.join(__dirname, "reports");
  await mkdir(reportsDir, { recursive: true });
  const out = path.join(reportsDir, `eval_${Date.now()}.json`);
  await writeFile(out, JSON.stringify(report, null, 2));
  console.log(`\n💾 리포트 저장: ${out}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
