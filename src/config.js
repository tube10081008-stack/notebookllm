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
};

export default config;
