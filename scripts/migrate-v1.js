// scripts/migrate-v1.js — v1(second-brain) 데이터 → v2 워크스페이스 마이그레이션
//
// v1의 data/ 디렉토리(로컬 파일 시절 산출물)를 v2 구조로 옮긴다.
// 개인 데이터는 코드 저장소가 아니라 WORKSPACE_ROOT로만 들어간다 (문제 ⑦).
//
// 사용: npm run migrate:v1 -- /path/to/v1/data
//   - v1의 stations.json + stations/<sid>/notes/*.json 을 읽는다
//   - _dup_ 파일은 건너뛴다 (v1 마이그레이션 잔재)
//   - 벡터는 옮기지 않는다 — 완료 후 `npm run reindex`로 현재 모델 기준 재구축 (불변식 2)
import path from "path";
import { readFile, readdir } from "fs/promises";
import * as ws from "../src/storage/workspace.js";
import * as stations from "../src/core/stations.js";

async function readJSONSafe(file) {
  try { return JSON.parse(await readFile(file, "utf-8")); } catch { return null; }
}

async function main() {
  const v1Root = process.argv[2];
  if (!v1Root) {
    console.error("사용법: npm run migrate:v1 -- /path/to/v1/data");
    process.exit(1);
  }

  const v1Stations = (await readJSONSafe(path.join(v1Root, "stations.json"))) || [];
  console.log(`📦 v1 스테이션 ${v1Stations.length}개 발견`);

  for (const old of v1Stations) {
    // 스테이션 생성 (v1 agent 정의 계승)
    const station = await stations.createStation({
      name: old.name,
      description: old.description,
      icon: old.icon,
      presetKey: "researcher",
      customAgent: old.agent,
    });
    console.log(`\n🏗  "${old.name}" → 새 스테이션 ${station.id}`);

    // 노트 이관
    const notesDir = path.join(v1Root, "stations", old.id, "notes");
    let files = [];
    try { files = (await readdir(notesDir)).filter((f) => f.endsWith(".json")); } catch { /* 없음 */ }

    let migrated = 0, skippedDup = 0;
    for (const f of files) {
      if (f.includes("_dup_")) { skippedDup++; continue; }
      const note = await readJSONSafe(path.join(notesDir, f));
      if (!note?.id) continue;
      note.station_id = station.id;
      note.migrated_from = { v1_station: old.id, file: f };
      await ws.saveNote(station.id, note);
      migrated++;
    }

    // 그래프 엣지 이관 (v1은 nodes+edges 구조였으나 엣지가 있으면 보존)
    const v1Graph = await readJSONSafe(path.join(v1Root, "stations", old.id, "graph.json"));
    if (Array.isArray(v1Graph?.edges) && v1Graph.edges.length > 0) {
      await ws.saveGraph(station.id, { edges: v1Graph.edges });
      console.log(`   🔗 엣지 ${v1Graph.edges.length}개 이관`);
    }

    await ws.appendEvent(station.id, "migrate.v1", { notes: migrated, skipped_dup: skippedDup, from: old.id });
    await stations.bumpStats(station.id, { note_count: migrated, source_count: old.stats?.source_count || 0 });
    console.log(`   📝 노트 ${migrated}개 이관 (중복 잔재 ${skippedDup}개 제외)`);
  }

  console.log(`\n✅ 마이그레이션 완료.`);
  console.log(`➡️  다음 단계: npm run reindex  (현재 임베딩 모델로 벡터 재구축 — 이것 없이는 검색 불가)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
