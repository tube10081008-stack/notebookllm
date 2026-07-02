// scripts/reindex.js — 벡터 전량 재구축 (불변식 2의 실전 효용)
//
// 임베딩 모델을 교체할 때(예: gemini-embedding-2 → 로컬 bge-m3) 실행한다.
// canonical인 notes에서 derived인 vectors를 다시 만든다 — 원문 손실 없음.
//
// 사용: npm run reindex            (모든 스테이션)
//       npm run reindex -- <sid>   (특정 스테이션)
import { getLLM } from "../src/llm/index.js";
import * as ws from "../src/storage/workspace.js";
import * as stations from "../src/core/stations.js";

async function reindexStation(station) {
  const llm = getLLM();
  const { embedModel, dims } = llm.info();
  const notes = await ws.loadAllNotes(station.id);
  console.log(`\n📦 ${station.name} (${station.id}) — 노트 ${notes.length}개 재임베딩 → ${embedModel}`);

  const items = {};
  let done = 0;
  for (const note of notes) {
    const v = await llm.embedOne(`${note.title} ${note.content}`);
    items[note.id] = {
      v,
      title: note.title,
      type: note.type,
      created_at: note.created_at,
      confidence: note.confidence,
    };
    done++;
    if (done % 20 === 0) console.log(`   ...${done}/${notes.length}`);
  }

  await ws.replaceVectorStore(station.id, { model: embedModel, dims, items });
  await ws.appendEvent(station.id, "reindex", { model: embedModel, dims, notes: notes.length });
  console.log(`   ✅ 완료 (${done}개)`);
}

async function main() {
  const targetSid = process.argv[2];
  const all = await stations.getAll();
  const targets = targetSid ? all.filter((s) => s.id === targetSid) : all;
  if (targets.length === 0) {
    console.error(targetSid ? `스테이션을 찾을 수 없습니다: ${targetSid}` : "스테이션이 없습니다.");
    process.exit(1);
  }

  console.log(`🔁 재인덱싱 대상: ${targets.length}개 스테이션 (provider: ${getLLM().info().provider})`);
  for (const s of targets) await reindexStation(s);
  console.log(`\n🎉 재인덱싱 완료. 이제 새 임베딩 모델로 질의할 수 있습니다.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
