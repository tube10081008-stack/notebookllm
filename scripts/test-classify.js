// scripts/test-classify.js — 콘텐츠 분류기 검증 코퍼스 (가설 증명용)
//
// 5개 논문에 근거한 실패 가설(H1~H5)을 인코딩한 라벨링 코퍼스.
// 현재 분류기를 돌려 오분류를 실측한다. "느낌이 아니라 숫자로."
//
// 사용: node scripts/test-classify.js
import { createRequire } from "module";
import { readFileSync, existsSync } from "fs";
import { classifyContent, classifyWithFallback } from "../src/core/distill.js";

const require = createRequire(import.meta.url);

// ── 코퍼스 (각 항목: 라벨 + 근거 가설) ──
const PROSE = `중국어의 성조는 의미를 구별하는 핵심 요소이다. 1성은 높고 평평하게 발음하며, 2성은 끝을 올린다. 3성은 낮게 내렸다가 다시 올리는 굴곡을 가지며, 4성은 높은 곳에서 뚝 떨어진다. 성조를 틀리면 전혀 다른 뜻이 되므로 처음부터 정확히 익혀야 한다. 특히 3성이 연속될 때 앞의 3성이 2성으로 바뀌는 변조 현상이 일어난다. 이런 규칙은 실제 발화에서 자연스럽게 적용된다. 학습자는 개별 성조뿐 아니라 연속된 성조의 흐름도 함께 연습해야 한다.`;

// 같은 산문을 물리적으로 45자에서 강제 줄바꿈 (PDF 추출 아티팩트 재현 — H1)
function hardWrap(text, width) {
  const words = text.replace(/\n/g, " ").split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).length > width) { lines.push(cur); cur = w; }
    else cur = cur ? cur + " " + w : w;
  }
  if (cur) lines.push(cur);
  return lines.join("\n");
}

const VOCAB = `爱 ài 사랑하다
八 bā 여덟
爸爸 bàba 아빠
杯子 bēizi 컵
本 běn 권
不 bù 아니다
菜 cài 요리
茶 chá 차
吃 chī 먹다
苹果 píngguǒ 사과
学校 xuéxiào 학교
老师 lǎoshī 선생님`;

const TABLE = `단어\t병음\t뜻
妈\tmā\t엄마
马\tmǎ\t말
吗\tma\t의문조사
骂\tmà\t꾸짖다
麻\tmá\t삼베
苹果\tpíngguǒ\t사과`;

const MIXED = `${PROSE}

아래는 이번 과의 핵심 단어 목록이다.

${VOCAB}`;

const NUMBERED_CONCEPT = `1. 미적분학의 제1기본정리는 누적 함수를 미분하면 원래 함수가 됨을 말한다.
2. 제2기본정리는 정적분을 부정적분의 차이로 계산할 수 있게 한다.
3. 이 두 정리는 미분과 적분이 역연산임을 보여준다.
4. 기하학적으로는 넓이의 변화율이 곧 높이라는 직관으로 이어진다.
5. 실생활에서는 속도와 거리의 관계 등에 두루 응용된다.
6. 따라서 미적분학 전체를 관통하는 핵심 원리로 평가받는다.`;

const corpus = [
  { name: "C1 순수 산문", label: "concept", hyp: "기준선", content: PROSE },
  { name: "C2 산문(45자 강제 줄바꿈)", label: "concept", hyp: "H1 PDF 줄바꿈 파편화", content: hardWrap(PROSE, 45) },
  { name: "C3 단어 리스트", label: "reference", hyp: "기준선", content: VOCAB },
  { name: "C4 탭 구분 표", label: "reference", hyp: "기준선", content: TABLE },
  { name: "C5 교재(설명+단어표)", label: "hybrid", hyp: "H4 표 낀 문서", content: MIXED },
  { name: "C6 번호매김 개념설명", label: "concept", hyp: "H3 단일피처 혼동", content: NUMBERED_CONCEPT },
];

// C7: 실제 학술 PDF (있으면)
const PDF_PATH = process.argv[2];
if (PDF_PATH && existsSync(PDF_PATH)) {
  const pdfParse = require("pdf-parse");
  const buf = readFileSync(PDF_PATH);
  const text = (await pdfParse(buf)).text.trim();
  corpus.push({ name: "C7 학술논문 PDF(산문+도표)", label: "hybrid", hyp: "H1+H4 실제 사례", content: text });
}

// ── 실행 ──
let pass = 0;
const fails = [];
console.log("분류 정확도 검증 (label = 정답, got = 분류기 판단)\n");
for (const item of corpus) {
  const r = classifyContent(item);
  const ok = r.mode === item.label;
  if (ok) pass++;
  else fails.push({ ...item, got: r.mode, reason: r.reason });
  console.log(`${ok ? "✅" : "❌"} ${item.name.padEnd(24)} 정답:${item.label.padEnd(10)} 판단:${r.mode.padEnd(10)} [${item.hyp}]`);
  if (r.confidence !== undefined) console.log(`     conf=${r.confidence?.toFixed?.(2) ?? r.confidence} · ${r.reason}`);
}
console.log(`\n휴리스틱 단독 정확도: ${pass}/${corpus.length} (${Math.round(pass / corpus.length * 100)}%)`);
if (fails.length) {
  console.log("── 남은 오분류 (애매 구간) ──");
  for (const f of fails) console.log(`  [${f.hyp}] ${f.name}: ${f.label} → ${f.got}`);
}

// ── LLM 폴백 포함 재측정 (애매 구간을 오라클이 해결) ──
// 오라클 LLM 스텁: 실제 Gemini가 할 판단(문장 밀도로 산문 인식)을 흉내 — 배선 검증용
const oracle = {
  async chat({ prompt }) {
    const t = prompt;
    const punct = (t.match(/[.!?。]/g) || []).length;
    const words = t.split(/\s+/).length;
    // 산문이면 concept, 표가 섞였으면 hybrid (밀도 + 짧은줄 동시)
    const shortLines = t.split(/\n/).filter((l) => l.trim() && l.trim().length <= 45).length;
    const density = punct / (words / 100);
    let mode = "reference";
    if (density >= 3 && shortLines >= 5) mode = "hybrid";
    else if (density >= 3) mode = "concept";
    return { mode, why: "oracle" };
  },
};
let pass2 = 0;
const fails2 = [];
for (const item of corpus) {
  const r = await classifyWithFallback(item, { llm: oracle });
  if (r.mode === item.label) pass2++;
  else fails2.push({ ...item, got: r.mode });
}
console.log(`\nLLM 폴백 포함 정확도: ${pass2}/${corpus.length} (${Math.round(pass2 / corpus.length * 100)}%)`);
for (const f of fails2) console.log(`  ❌ ${f.name}: ${f.label} → ${f.got}`);
