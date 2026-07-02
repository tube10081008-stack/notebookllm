// scripts/migrate-to-stations.js — 기존 데이터를 스테이션 구조로 마이그레이션
import { readFile, writeFile, readdir, mkdir, copyFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config();

import * as stationManager from "../lib/station-manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OLD_DATA_DIR = path.resolve(__dirname, "../data");
const OLD_NOTES_DIR = path.join(OLD_DATA_DIR, "notes");
const OLD_VECTORS = path.join(OLD_DATA_DIR, "vectors.json");
const OLD_GRAPH = path.join(OLD_DATA_DIR, "graph.json");
const OLD_TAXONOMY = path.join(OLD_DATA_DIR, "taxonomy.json");

async function main() {
  console.log("🔄 기존 데이터 → BrainStation 마이그레이션 시작\n");

  await stationManager.init();

  // 1) 기존 노트 확인
  if (!existsSync(OLD_NOTES_DIR)) {
    console.log("❌ 기존 노트가 없습니다. (data/notes/ 디렉토리 없음)");
    return;
  }

  const files = await readdir(OLD_NOTES_DIR);
  const noteFiles = files.filter(f => f.endsWith(".json"));
  console.log(`📊 기존 노트: ${noteFiles.length}개`);

  if (noteFiles.length === 0) {
    console.log("⚠️ 마이그레이션할 노트가 없습니다.");
    return;
  }

  // 2) "아날로그 홀리데이" 스테이션 생성
  console.log("\n📡 '아날로그 홀리데이' 스테이션 생성 중...");
  const station = await stationManager.createStation({
    name: "아날로그 홀리데이",
    description: "여행 렌탈 비즈니스 — 에이전트(하니, 지오, 노아, 리나, 알렉스)의 통합 지식",
    icon: "🏖️",
    presetKey: "strategist",
    customAgent: {
      name: "팀장",
      avatar: "🏖️",
      tone: "팀 전체를 아우르는, 전략적인",
      expertise: "여행 렌탈 비즈니스 전략",
      greeting: "아날로그 홀리데이 팀의 지식이 모여있어요! 무엇이 궁금하세요?",
      color: "#F59E0B",
      system_prompt: `당신은 '아날로그 홀리데이' 여행 렌탈 비즈니스의 팀장입니다.
마케팅(하니), 물류(지오), 재무/데이터(노아), UX(리나), 브랜딩(알렉스) 5개 부서의 지식을 통합적으로 다룹니다.
한국어로 답변하되 비즈니스/마케팅 용어는 영어로 유지하세요.
실무적이고 전략적인 관점에서 답변합니다.`,
    },
  });

  console.log(`   ✅ 스테이션 ID: ${station.id}`);

  // 3) 노트 파일 복사
  const stationNotesDir = path.join(stationManager.getStationDataPath(station.id), "notes");
  console.log(`\n📝 노트 파일 복사 중...`);

  let copied = 0;
  for (const f of noteFiles) {
    try {
      const src = path.join(OLD_NOTES_DIR, f);
      const dest = path.join(stationNotesDir, f);

      // 노트에 station_id 추가
      const note = JSON.parse(await readFile(src, "utf-8"));
      note.station_id = station.id;
      await writeFile(dest, JSON.stringify(note, null, 2), "utf-8");
      copied++;
    } catch (err) {
      console.error(`   ❌ ${f}: ${err.message}`);
    }
  }
  console.log(`   ✅ ${copied}개 복사 완료`);

  // 4) 벡터 인덱스 복사
  if (existsSync(OLD_VECTORS)) {
    const dest = path.join(stationManager.getStationDataPath(station.id), "vectors.json");
    await copyFile(OLD_VECTORS, dest);
    console.log("📦 벡터 인덱스 복사 완료");
  }

  // 5) 그래프 복사
  if (existsSync(OLD_GRAPH)) {
    const dest = path.join(stationManager.getStationDataPath(station.id), "graph.json");
    await copyFile(OLD_GRAPH, dest);
    console.log("🕸️ 그래프 복사 완료");
  }

  // 6) Taxonomy 복사
  if (existsSync(OLD_TAXONOMY)) {
    const dest = path.join(stationManager.getStationDataPath(station.id), "taxonomy.json");
    await copyFile(OLD_TAXONOMY, dest);
    console.log("🏷️ Taxonomy 복사 완료");
  }

  // 7) 스테이션 통계 업데이트
  await stationManager.updateStats(station.id, {
    note_count: copied,
    source_count: copied,
  });

  console.log("\n" + "═".repeat(50));
  console.log("🎉 마이그레이션 완료!");
  console.log("═".repeat(50));
  console.log(`\n📡 스테이션: "${station.name}" (${station.id})`);
  console.log(`   🏖️ 에이전트: ${station.agent.name}`);
  console.log(`   📝 노트: ${copied}개`);
  console.log(`   🎮 레벨: ${station.gamification.level} (${station.gamification.title})`);
  console.log("═".repeat(50) + "\n");
}

main().catch(err => { console.error("❌ 마이그레이션 실패:", err); process.exit(1); });
