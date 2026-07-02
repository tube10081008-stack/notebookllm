// scripts/migrate-to-firestore.js — 로컬 JSON 데이터 -> Firestore 데이터베이스 일괄 마이그레이션
import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import admin from "firebase-admin";

// Firebase 초기화
if (!existsSync("firebase-key.json")) {
  console.error("❌ 마이그레이션을 진행하려면 로컬에 'firebase-key.json' 파일이 존재해야 합니다.");
  process.exit(1);
}

const serviceAccount = JSON.parse(await readFile("firebase-key.json", "utf8"));
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const DATA_DIR = "data";
const STATIONS_META = path.join(DATA_DIR, "stations.json");

async function runMigration() {
  console.log("🚚 로컬 지식 데이터 -> Firestore 마이그레이션 작업을 시작합니다...");
  
  if (!existsSync(STATIONS_META)) {
    console.log("ℹ️ 로컬 스테이션 메타데이터 파일이 존재하지 않아 마이그레이션을 종료합니다.");
    return;
  }

  const stations = JSON.parse(await readFile(STATIONS_META, "utf8"));
  console.log(`📡 발견된 로컬 스테이션 개수: ${stations.length}개`);

  for (const station of stations) {
    const sid = station.id;
    console.log(`\n======================================================`);
    console.log(`[스테이션 마이그레이션] ${station.name} (${sid})`);
    console.log(`======================================================`);

    // 1) 스테이션 기본 정보 업로드
    await db.collection("stations").doc(sid).set(station);
    console.log("✅ 1. 스테이션 메타데이터 저장 완료.");

    const stationDir = path.join(DATA_DIR, "stations", sid);
    if (!existsSync(stationDir)) {
      console.log(`⚠️ 스테이션 폴더를 찾을 수 없습니다: ${stationDir} (기본값 건너뜀)`);
      continue;
    }

    // 2) 개별 노트(Notes) 마이그레이션
    const notesDir = path.join(stationDir, "notes");
    if (existsSync(notesDir)) {
      const noteFiles = await readdir(notesDir);
      console.log(`  - 📋 노트를 업로드합니다 (${noteFiles.length}개)...`);
      for (const file of noteFiles) {
        if (!file.endsWith(".json")) continue;
        const noteId = file.replace(".json", "");
        try {
          const noteData = JSON.parse(await readFile(path.join(notesDir, file), "utf8"));
          await db.collection("stations").doc(sid).collection("notes").doc(noteId).set(noteData);
        } catch (err) {
          console.error(`  ❌ 노트 업로드 실패 (${file}):`, err.message);
        }
      }
      console.log("✅ 2. 개별 지식 노트 업로드 완료.");
    }

    // 3) 벡터 데이터(Vectors) 마이그레이션
    const vectorsPath = path.join(stationDir, "vectors.json");
    if (existsSync(vectorsPath)) {
      console.log("  - 🗺️ 임베딩 벡터 데이터를 마이그레이션합니다...");
      try {
        const vectors = JSON.parse(await readFile(vectorsPath, "utf8"));
        for (const [nid, vec] of Object.entries(vectors)) {
          await db.collection("stations").doc(sid).collection("vectors").doc(nid).set(vec);
        }
        console.log("✅ 3. 벡터 저장소 마이그레이션 완료.");
      } catch (err) {
        console.error("  ❌ 벡터 데이터 마이그레이션 실패:", err.message);
      }
    }

    // 4) 대화록(Chats) 마이그레이션
    const chatsPath = path.join(stationDir, "chats.json");
    if (existsSync(chatsPath)) {
      console.log("  - 💬 대화 기록을 마이그레이션합니다...");
      try {
        const chats = JSON.parse(await readFile(chatsPath, "utf8"));
        for (const chat of chats) {
          await db.collection("stations").doc(sid).collection("chats").add(chat);
        }
        console.log(`✅ 4. 대화 기록 ${chats.length}건 저장 완료.`);
      } catch (err) {
        console.error("  ❌ 대화 데이터 마이그레이션 실패:", err.message);
      }
    }

    // 5) 지식 그래프(Graph) 마이그레이션
    const graphPath = path.join(stationDir, "graph.json");
    if (existsSync(graphPath)) {
      try {
        const graphData = JSON.parse(await readFile(graphPath, "utf8"));
        await db.collection("stations").doc(sid).collection("metadata").doc("graph").set(graphData);
        console.log("✅ 5. 지식 그래프 메타데이터 저장 완료.");
      } catch (err) {
        console.error("  ❌ 그래프 저장 실패:", err.message);
      }
    }

    // 6) 분류체계(Taxonomy) 마이그레이션
    const taxonomyPath = path.join(stationDir, "taxonomy.json");
    if (existsSync(taxonomyPath)) {
      try {
        const taxData = JSON.parse(await readFile(taxonomyPath, "utf8"));
        await db.collection("stations").doc(sid).collection("metadata").doc("taxonomy").set(taxData);
        console.log("✅ 6. 토픽 분류 체계 저장 완료.");
      } catch (err) {
        console.error("  ❌ 분류체계 저장 실패:", err.message);
      }
    }

    // 7) 원문 보관소(Raw) 마이그레이션
    const rawDir = path.join(stationDir, "raw");
    if (existsSync(rawDir)) {
      const rawFiles = await readdir(rawDir);
      console.log(`  - 📦 무수정 원문 백업을 마이그레이션합니다 (${rawFiles.length}개)...`);
      for (const file of rawFiles) {
        if (!file.endsWith(".json")) continue;
        const rawId = file.replace(".json", "");
        try {
          const rawData = JSON.parse(await readFile(path.join(rawDir, file), "utf8"));
          await db.collection("stations").doc(sid).collection("raw").doc(rawId).set(rawData);
        } catch (err) {
          console.error(`  ❌ 원문 업로드 실패 (${file}):`, err.message);
        }
      }
      console.log("✅ 7. 무수정 원문 업로드 완료.");
    }
  }

  console.log("\n🎉 모든 로컬 지식 데이터가 Firestore 클라우드로 이사를 마쳤습니다!");
}

runMigration().catch(err => {
  console.error("❌ 마이그레이션 중 치명적인 에러 발생:", err);
});
