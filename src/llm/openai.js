// src/llm/openai.js — OpenAI 호환 provider (최종 목표: 로컬 오픈모델)
// Ollama(http://localhost:11434/v1), LM Studio, vLLM 등 OpenAI 호환 서버 전부 지원.
// 파인튜닝한 Jay/코라 GGUF를 LLM_TEXT_MODEL로 지정하면 페르소나가 모델 레벨로 이동한다.
export function createOpenAIProvider(cfg, { withRetry, parseModelJSON }) {
  const { baseURL, apiKey, textModel, visionModel, embedModel } = cfg.openai;
  const dims = cfg.embedDims;

  async function call(path, body) {
    const res = await fetch(`${baseURL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const err = new Error(`OpenAI-compat ${path} ${res.status}: ${detail.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  return {
    info: () => ({ provider: "openai", baseURL, textModel, embedModel, dims }),

    async chat({ system, prompt, json = false, schema = null }) {
      return withRetry(async () => {
        const messages = [];
        if (system) messages.push({ role: "system", content: system });
        messages.push({ role: "user", content: prompt });

        const body = { model: textModel, messages };
        if (json) {
          // json_schema 미지원 서버(일부 로컬 서버)를 위해 json_object로 폴백 가능하게 단순 형식 사용
          body.response_format = { type: "json_object" };
          // 로컬 모델은 스키마 강제가 약하므로 프롬프트에도 형식을 명시하는 것은 호출부 책임
        }
        const data = await call("/chat/completions", body);
        const text = data?.choices?.[0]?.message?.content ?? "";
        return json ? parseModelJSON(text) : text;
      });
    },

    async embed(texts) {
      const data = await withRetry(() => call("/embeddings", { model: embedModel, input: texts }));
      const vectors = (data?.data || []).map((d) => d.embedding);
      if (vectors.length !== texts.length) throw new Error("임베딩 응답 개수 불일치");
      return { model: embedModel, dims: vectors[0]?.length ?? dims, vectors };
    },

    async embedOne(text) {
      const { vectors } = await this.embed([text]);
      return vectors[0];
    },

    async describeMedia({ mimeType, dataBase64, instruction }) {
      const model = visionModel || textModel;
      return withRetry(async () => {
        const data = await call("/chat/completions", {
          model,
          messages: [{
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${dataBase64}` } },
              { type: "text", text: instruction },
            ],
          }],
        });
        return data?.choices?.[0]?.message?.content ?? "";
      });
    },
  };
}
