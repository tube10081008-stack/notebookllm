// src/core/agentsmith.js — 에이전트 대장간 (헌장 → 전담 에이전트 합성)
//
// [에이전트 선택] 재설계의 근거:
//   기존 고정 프리셋 6종은 헌장과 "중복 입력"이었다 — 목적을 설문에 쓰고
//   또 페르소나를 고르는 것은 같은 정보를 두 번 말하는 것이고, 요리 스테이션과
//   ML 논문 스테이션이 똑같은 '루나'를 받는다는 것은 페르소나가 장식이라는 뜻이다.
//
// 새 원칙: **에이전트는 헌장의 파생물(derived)이다.**
//   - 정체성(이름·이모지·말투·전문성·시스템 프롬프트)은 헌장의 도메인에 맞게 LLM이 합성
//   - 행동 파라미터(증류 전략·검색 가중치·답변 스타일)는 검증된 6개 아키타입
//     (AGENT_BEHAVIORS) 중 하나로 "분류"만 시킨다 — 수치는 LLM이 창작하지 못하게 (eval로 검증된 경계 유지)
//   - 헌장이 진화하면(토픽 변경·거절 누적) 재조율(retune)로 다시 파생시킨다
//   - 합성 실패 시 기존 프리셋으로 폴백 — 프리셋은 삭제가 아니라 안전망으로 강등
import { getLLM } from "../llm/index.js";
import { AGENT_PRESETS, AGENT_BEHAVIORS } from "./personas.js";

const ARCHETYPES = Object.keys(AGENT_BEHAVIORS); // analytical | decisive | creative | methodical | practical | curious

const AGENT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },          // 한국어 이름 2~6자
    avatar: { type: "string" },        // 이모지 1개
    tone: { type: "string" },          // "~하고 ~한" 형태의 말투 묘사
    expertise: { type: "string" },     // 전문 분야 한 줄
    greeting: { type: "string" },      // 첫 인사 (1문장)
    personality: { type: "string", enum: ARCHETYPES }, // 행동 아키타입 분류
    system_prompt: { type: "string" }, // 4~6줄 시스템 프롬프트
  },
  required: ["name", "avatar", "tone", "expertise", "personality", "system_prompt"],
};

function firstEmoji(s) {
  const m = String(s || "").match(/\p{Extended_Pictographic}/u);
  return m ? m[0] : "🧠";
}

const ARCHETYPE_COLORS = {
  analytical: "#7C3AED", decisive: "#F59E0B", creative: "#EC4899",
  methodical: "#06B6D4", practical: "#10B981", curious: "#8B5CF6",
};

// 합성 결과를 검증·정규화한다. LLM 출력은 제안일 뿐, 경계는 코드가 지킨다.
function sanitizeAgent(raw, fallback) {
  const personality = ARCHETYPES.includes(raw?.personality) ? raw.personality : fallback.personality;
  return {
    name: String(raw?.name || fallback.name).trim().slice(0, 12) || fallback.name,
    avatar: firstEmoji(raw?.avatar),
    personality,
    tone: String(raw?.tone || fallback.tone).trim().slice(0, 60),
    expertise: String(raw?.expertise || fallback.expertise).trim().slice(0, 80),
    greeting: String(raw?.greeting || fallback.greeting).trim().slice(0, 150),
    system_prompt: String(raw?.system_prompt || fallback.system_prompt).trim().slice(0, 1500),
    color: ARCHETYPE_COLORS[personality] || "#7C3AED",
    synthesized: true,
    synthesized_at: new Date().toISOString(),
  };
}

// charter (+ 선택적 컨텍스트)에서 전담 에이전트를 합성한다.
// context: { topicCounts?: {토픽: 수}, rejections?: [사유...] } — 재조율 시 축적 데이터 반영
export async function synthesizeAgent(charter, context = {}) {
  const fallback = AGENT_PRESETS.researcher;

  const hasDirection = (charter?.purpose || "").trim() || (charter?.topics || []).length > 0;
  if (!hasDirection) return { ...fallback, synthesized: false }; // 방향 없으면 합성할 재료가 없다

  const learnedContext = (context.rejections || []).slice(-5);
  const topTopics = Object.entries(context.topicCounts || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, n]) => `${t}(${n})`);

  const system = `당신은 지식 스테이션의 전담 AI 에이전트를 설계하는 전문가입니다.
스테이션의 지식 헌장을 읽고, 그 도메인에 꼭 맞는 에이전트 하나를 설계하세요.

행동 아키타입 분류 기준 (personality — 반드시 이 중 하나):
- analytical: 근거·정확성이 중요한 도메인 (연구, 논문, 기술 분석)
- decisive: 빠른 판단·실행이 중요한 도메인 (비즈니스, 전략, 투자)
- creative: 발상·연결이 중요한 도메인 (디자인, 콘텐츠, 글쓰기)
- methodical: 체계·누락 없음이 중요한 도메인 (법률, 절차, 아카이빙)
- practical: 동작하는 결과가 중요한 도메인 (개발, 요리, 공예, DIY)
- curious: 분야 간 연결·트렌드가 중요한 도메인 (교양, 다학제, 탐구)

JSON 객체로만 응답하세요:
{"name":"한국어 이름 2~6자 (도메인 느낌이 나게)","avatar":"이모지 1개","tone":"말투 묘사","expertise":"전문 분야 한 줄","greeting":"첫 인사 1문장","personality":"아키타입","system_prompt":"이 에이전트의 시스템 프롬프트 4~6줄. 한국어 답변·기술용어 영어 유지·전문성과 답변 태도를 구체적으로."}`;

  const prompt = `[지식 헌장]
목적: ${charter.purpose || "(없음)"}
핵심 토픽: ${(charter.topics || []).join(", ") || "(없음)"}
제외: ${(charter.exclude || []).join(", ") || "(없음)"}
${topTopics.length ? `\n[실제 축적된 지식 분포] ${topTopics.join(", ")}` : ""}
${learnedContext.length ? `\n[사용자가 거절한 소스의 사유 — 취향 신호]\n${learnedContext.map((r) => `- ${r}`).join("\n")}` : ""}

이 스테이션의 전담 에이전트를 설계해주세요.`;

  try {
    const raw = await getLLM().chat({ system, prompt, json: true, schema: AGENT_SCHEMA });
    return sanitizeAgent(raw, fallback);
  } catch (err) {
    console.warn("⚠️ 에이전트 합성 실패, 기본 프리셋으로 폴백:", err.message);
    return { ...fallback, synthesized: false };
  }
}
