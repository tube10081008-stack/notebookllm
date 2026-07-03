// src/llm/gemini.js — Gemini REST provider ("빌린 API" 단계)
// SDK 대신 순수 fetch를 쓴다: 의존성 자체가 provider 종속이기 때문 (불변식 4).
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export function createGeminiProvider(cfg, { withRetry, parseModelJSON }) {
  const { apiKey, textModel, embedModel } = cfg.gemini;
  const dims = cfg.embedDims;

  if (!apiKey) {
    console.warn("⚠️ GEMINI_API_KEY가 없습니다. LLM 호출은 실패합니다. (.env 확인 또는 LLM_PROVIDER=mock)");
  }

  async function call(model, endpoint, body) {
    const res = await fetch(`${API_BASE}/${model}:${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const err = new Error(`Gemini ${endpoint} ${res.status}: ${detail.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  return {
    info: () => ({ provider: "gemini", textModel, embedModel, dims }),

    // json:true 이면 responseMimeType으로 구조화 출력을 강제한다 (v1 문제 ⑧의 해결).
    // schema는 Gemini responseSchema 형식 (OpenAPI 스키마 서브셋).
    async chat({ system, prompt, json = false, schema = null }) {
      return withRetry(async () => {
        const body = {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {},
        };
        if (system) body.systemInstruction = { parts: [{ text: system }] };
        if (json) {
          body.generationConfig.responseMimeType = "application/json";
          if (schema) body.generationConfig.responseSchema = schema;
        }
        const data = await call(textModel, "generateContent", body);
        const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ?? "";
        return json ? parseModelJSON(text) : text;
      });
    },

    async embed(texts) {
      const vectors = [];
      for (const text of texts) {
        const v = await withRetry(async () => {
          const data = await call(embedModel, "embedContent", {
            content: { parts: [{ text }] },
            outputDimensionality: dims,
          });
          return data?.embedding?.values;
        });
        if (!Array.isArray(v)) throw new Error("Gemini 임베딩 응답 형식 오류");
        vectors.push(v);
      }
      return { model: embedModel, dims, vectors };
    },

    async embedOne(text) {
      const { vectors } = await this.embed([text]);
      return vectors[0];
    },

    // YouTube 영상 직접 분석 — Gemini의 네이티브 비디오 이해 (자막 추출 실패 시 폴백)
    // 자막보다 나은 결과를 주기도 한다: 화면의 수식·도표까지 본다.
    async transcribeVideo({ url, instruction }) {
      return withRetry(async () => {
        const data = await call(textModel, "generateContent", {
          contents: [{
            role: "user",
            parts: [
              { fileData: { fileUri: url } },
              { text: instruction },
            ],
          }],
        });
        return data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ?? "";
      });
    },

    // 이미지/스캔 PDF → 텍스트 (v1 문제 ⑨: parser의 SDK 직접 호출을 창구 안으로)
    async describeMedia({ mimeType, dataBase64, instruction }) {
      return withRetry(async () => {
        const data = await call(textModel, "generateContent", {
          contents: [{
            role: "user",
            parts: [
              { inlineData: { mimeType, data: dataBase64 } },
              { text: instruction },
            ],
          }],
        });
        return data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ?? "";
      });
    },
  };
}
