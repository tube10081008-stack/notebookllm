// lib/firebase.js — Firebase Admin SDK 초기화
import admin from "firebase-admin";
import { existsSync, readFileSync } from "fs";

let db;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("☁️ Firebase Admin SDK가 환경변수(FIREBASE_SERVICE_ACCOUNT)로부터 연결되었습니다.");
  } else if (existsSync("firebase-key.json")) {
    const serviceAccount = JSON.parse(readFileSync("firebase-key.json", "utf8"));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("🔑 Firebase Admin SDK가 로컬 key 파일(firebase-key.json)로부터 연결되었습니다.");
  } else {
    // ADC (Application Default Credentials) 폴백
    admin.initializeApp();
    console.log("📡 Firebase Admin SDK가 기본 자격 증명으로 시작되었습니다.");
  }
  db = admin.firestore();
} catch (err) {
  console.error("❌ Firebase Admin SDK 초기화 실패:", err.message);
  // db가 undefined인 상태로 남지 않도록 프록시 객체를 할당해서
  // 명확한 에러 메시지를 제공합니다.
  db = new Proxy({}, {
    get(target, prop) {
      throw new Error(
        `Firebase가 초기화되지 않았습니다 (${String(prop)} 호출됨). ` +
        `환경변수 FIREBASE_SERVICE_ACCOUNT 또는 firebase-key.json을 확인하세요. ` +
        `원인: ${err.message}`
      );
    }
  });
}

export { db, admin };
export default db;
