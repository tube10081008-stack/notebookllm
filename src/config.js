// src/config.js — 환경 설정 단일 창구
import dotenv from "dotenv";
import path from "path";

dotenv.config({ quiet: true });

export const config = {
  provider: process.env.LLM_PROVIDER || "gemini",

  gemini: {
    apiKey: process.env.GEMINI_API_KEY || "",
    textModel: process.env.GEMINI_TEXT_MODEL || "gemini-3.5-flash",
    embedModel: process.env.GEMINI_EMBED_MODEL || "gemini-embedding-2",
  },

  openai: {
    baseURL: process.env.LLM_BASE_URL || "http://localhost:11434/v1",
    apiKey: process.env.LLM_API_KEY || "ollama",
    textModel: process.env.LLM_TEXT_MODEL || "qwen2.5:3b",
    visionModel: process.env.LLM_VISION_MODEL || "",
    embedModel: process.env.LLM_EMBED_MODEL || "bge-m3",
  },

  embedDims: Number(process.env.EMBED_DIMS || 768),

  server: {
    port: Number(process.env.PORT || 3456),
    host: process.env.HOST || "127.0.0.1",
    authToken: process.env.AUTH_TOKEN || "",
  },

  workspaceRoot: path.resolve(process.env.WORKSPACE_ROOT || "./data"),

  // 답변 시 노트를 "근거"로 인정할 최소 벡터 관련도. 미달이면 일반 지식 혼합 모드로 전환.
  // ⚠️ 가설 수치 — 변경 시 npm run eval + 실사용으로 검증할 것.
  relevanceFloor: Number(process.env.RELEVANCE_FLOOR || 0.45),

  // 사설망 URL 수집 허용 (사내망 피드·로컬 테스트용 opt-in. 공개 서버에선 켜지 말 것)
  allowPrivateNet: process.env.ALLOW_PRIVATE_NET === "1",
};

export default config;
