# BrainStation 2 — 아키텍처 명세

> **한 줄 명제:** 모델은 소비재, 데이터는 자산.
> 이 시스템은 10년간 데이터가 쌓여도 후회하지 않도록, **진실(truth) → 출처(provenance) → 복원 가능성(reversibility) → 자동화 → 지능** 순서로 설계되었다. 절대 그 반대가 아니다.

이 문서는 v1(second-brain)과 LLM-WIKI(P-Reinforce), claudeWIKI(RAG/파인튜닝 실측)의 검토에서 얻은
결론을 코드 구조로 옮긴 기록이다. 모든 설계 결정에는 "왜"가 붙어 있다.

---

## 1. v1 검토에서 가져온 것 / 고친 것

### 계승한 것 (v1의 훌륭한 점)
| 자산 | 출처 | v2에서의 위치 |
| --- | --- | --- |
| 원문(Raw) 무수정 영구 보관 | v1 `saveRawSource` + P-Reinforce `00_Raw` 불변 원칙 | `raw/` 디렉토리, 덮어쓰기 거부 |
| 원자적 노트 증류 (type/confidence/half_life/why_saved) | v1 `distiller.js` | `src/core/distill.js` |
| 페르소나 에이전트 6종 + 성격별 증류·검색·답변 전략 | v1 `station-manager.js` + `agent-config.js` | `src/core/personas.js` |
| 인용(citation) 기반 답변 + 볼드 인용 규칙 | v1 `/query` 프롬프트 | `src/core/answer.js` |
| 협의회(Council) 멀티에이전트 패널 | v1 `council.js` (Day 7 멀티에이전트 이론) | `src/core/council.js` |
| 지식 반감기(half-life)·decay·GC 관점 | v1 `gc-agent.js` | `src/core/gc.js` |
| 그래프 확장 + 종합 랭킹 검색 | v1 `retriever.js` — **죽은 코드였음** | `src/core/retrieve.js`로 소생 |

### 고친 것 (v1 검토에서 확인된 문제 → v2의 답)
| # | v1의 문제 | v2의 답 |
| --- | --- | --- |
| ① | `proposeLinks`가 import만 되고 호출되지 않아 **그래프 엣지가 영원히 생성되지 않음** | ingest 파이프라인이 노트 저장 직후 반드시 링크 제안을 실행 (`src/core/ingest.js`) |
| ② | 최고의 검색 코드(`retriever.js`: 그래프 2-hop 확장 + 종합 랭킹)가 미사용, 실제 질의는 단순 코사인 | `retrieve.js`가 유일한 검색 경로. 벡터 + 그래프 확장 + `관련도·신뢰도·최신성·반감기` 종합 랭킹 |
| ③ | 저장 계층 이원화 (Firestore `db.js` vs 로컬 `vector-store.js`/`graph.js`) — GC·retriever는 로컬 세계에 고립 | **단일 storage 인터페이스** (`src/storage/`). 현재 구현체는 filesystem 하나. 모든 코어 모듈이 이 인터페이스만 사용 |
| ④ | 질의마다 전체 벡터를 Firestore에서 재로드, cross-station은 이를 전 스테이션 반복 | 스테이션별 벡터를 **프로세스 메모리에 캐시** (파일이 진실, 캐시는 파생). 쓰기 경로가 캐시를 일관되게 갱신 |
| ⑤ | 서버리스 인스턴스별 인메모리 상태 불일치, read-modify-write 레이스 | **로컬 우선(local-first)** 선언. 단일 프로세스가 워크스페이스를 소유. 클라우드 배포는 "미리보기 모드"로 격하 (P-Reinforce의 결론과 동일) |
| ⑥ | 인증 전무 — 배포 시 노트·대화 전체가 공개, 타인이 API 할당량 소모 가능 | `AUTH_TOKEN` 미들웨어. localhost 밖 노출 시 필수 |
| ⑦ | 개인 일기·실명이 코드 저장소에 커밋되어 public 노출 | **데이터와 코드의 완전 분리.** `WORKSPACE_ROOT`는 gitignore. 지식은 별도 private 저장소에서 영속화 |
| ⑧ | LLM JSON 응답을 정규식으로 세척 후 `JSON.parse` (3곳 중복) | provider 레벨의 **구조화 출력** (`responseSchema` / `response_format`) + 단일 파서 |
| ⑨ | `parser.js`가 Gemini SDK를 직접 호출 → provider 창구 우회 (OCR/이미지) | 멀티모달 포함 **모든 LLM 호출이 `src/llm/` 단일 창구** 통과 |
| ⑩ | 임베딩 벡터에 생성 모델 정보가 없어 모델 교체 = 도박 | 벡터 파일에 `{model, dims}` 각인. 불일치 감지 시 질의 거부 + `npm run reindex` 안내 |
| ⑪ | recencyBias·confidenceWeight 등 랭킹 휴리스틱이 무검증 | `eval/` 골든셋 평가 (claudeWIKI rag-poc 방법론 이식): Hit@1 / Recall@k / MRR을 LLM 없이 실측 |
| ⑫ | `parseURL`의 SSRF (내부망 fetch 가능), 프런트 innerHTML XSS 여지 | URL 사설망 차단 검증, 프런트는 escape-first 렌더링 |
| ⑬ | *(v2 개발 중 자체 발견)* checkpoint가 상위 코드 저장소를 워크스페이스 git으로 오인해 커밋 — "조용한 덮어쓰기"의 실사례 | `git rev-parse --show-toplevel`이 워크스페이스 루트와 일치할 때만 커밋 허용. Reflection Rule Q2가 실제로 작동한 기록 |

---

## 2. 핵심 불변식 (Core Invariants) — 10년 규칙

1. **`raw/`는 불변이다.** 한 번 저장된 원문은 수정·삭제되지 않는다 (파일 존재 시 쓰기 거부).
2. **노트(`notes/`)가 canonical, 벡터(`vectors.json`)는 derived다.**
   벡터는 언제든 `notes + 임베딩 모델`로 재구축 가능하다 (`npm run reindex`).
   derived 아티팩트만 갱신하고 완료를 주장하는 코드는 금지.
3. **모든 상태 변경은 `events.jsonl`에 append-only로 남는다.** (수집/증류/적용/질의/GC/수정/삭제)
4. **provider는 언제든 사라질 수 있다.** 지식 포맷(JSON/Markdown 가능 텍스트)은 특정 API에 종속되지 않는다.
   LLM 호출은 `src/llm/index.js`의 인터페이스(`chat`/`embed`/`describeMedia`)로만 한다.
5. **에이전트는 사용자 동의 없이 진실을 파괴하지 않는다.** GC는 삭제하지 않고 **보고서(제안)**만 만든다.
6. **stable ID > 파일명, 출처 > 요약.** 모든 노트는 uuid와 source(제목/URL/저자/일시)를 가진다.
7. **쓰기는 원자적이다.** tmp 파일 작성 후 rename (동시성·중단 대비).

## 3. 워크스페이스 레이아웃 (진실의 원천)

```
WORKSPACE_ROOT/                      ← 별도 private git 저장소 권장
├── stations.json                    # 스테이션 목록 (canonical)
└── stations/<station-id>/
    ├── raw/<ts>_<slug>.json         # 불변 원문 (canonical, 덮어쓰기 거부)
    ├── notes/<uuid>.json            # 원자적 노트 (canonical)
    ├── graph.json                   # 노트 간 관계 엣지 (canonical — LLM 제안, 사용자 수정 가능)
    ├── vectors.json                 # 임베딩 (derived — model/dims 각인, 재구축 가능)
    ├── chats.jsonl                  # 대화 아카이브 (append-only)
    └── events.jsonl                 # 감사 로그 (append-only)
```

모두 사람이 읽을 수 있는 JSON/JSONL이다. 10년 뒤 이 서비스가 사라져도
`grep`과 텍스트 에디터만으로 지식을 온전히 회수할 수 있다.

## 4. LLM Provider 추상화 — "빌린 API → 오픈모델" 전환 경로

```
src/llm/index.js      createLLM(config) → { chat, embed, describeMedia }
src/llm/gemini.js     Gemini REST (현재. 빌린 API 단계)
src/llm/openai.js     OpenAI 호환 REST — Ollama/LM Studio/vLLM (최종 목표)
src/llm/mock.js       키 없이 동작하는 결정적 더미 (테스트/데모)
```

- SDK를 쓰지 않고 순수 `fetch`만 사용한다 — 의존성 자체가 provider 종속이기 때문.
- 전환 절차:
  1. **생성 먼저**: `LLM_PROVIDER=openai` + `LLM_BASE_URL=http://localhost:11434/v1` +
     `LLM_TEXT_MODEL=<파인튜닝한 Jay/코라 GGUF>` — 벡터와 무관하므로 즉시 전환 가능.
  2. **임베딩은 나중에**: 임베딩 모델 교체는 전량 재임베딩을 의미한다.
     `npm run reindex`가 raw가 아닌 **notes**에서 벡터를 재구축한다 (불변식 2의 실전 효용).
- 답변 스타일(페르소나)은 두 층으로 존재한다:
  프롬프트 페르소나(지금) → 파인튜닝 페르소나(로컬 모델 전환 후). 같은 station.agent 정의를 공유.

## 5. 검색 파이프라인 (v1 retriever.js의 소생 + 실측 가능화)

```
질문 → 임베딩 → 벡터 topK (페르소나별 K)
     → 그래프 2-hop 확장 (top5 기점, supports/contradicts/... 엣지)
     → 종합 랭킹: 관련도 0.55 + 신뢰도 w_c + 최신성 w_r + 접근성 0.1
        (w_c, w_r은 페르소나 행동 설정에서)
     → 반감기 만료 노트는 점수 0.5배 (지식은 썩는다)
     → 인용과 함께 답변 생성 (구조화 출력)
```

**이 파이프라인의 모든 가중치는 가설이다.** `eval/run-eval.js`가 골든셋으로
Hit@1/Recall@5/MRR을 LLM 없이 측정한다. 가중치를 바꾸면 반드시 숫자로 회귀를 확인한다.
(claudeWIKI 실측 교훈: 더미 dense가 섞인 하이브리드는 BM25 단독보다 나빴다 — 느낌은 배신한다.)

## 6. 신뢰 경계

- `AUTH_TOKEN` 설정 시 모든 `/api/*`에 Bearer 토큰 요구 (`/api/health` 제외).
- 기본 바인딩은 `127.0.0.1`. 외부 노출은 명시적 선택 + 토큰 필수.
- `parseURL`은 사설망/루프백/메타데이터 IP를 거부한다 (SSRF 차단).
- 프런트엔드는 escape-first: 모든 동적 문자열은 이스케이프 후 제한된 마크업(볼드·인용 배지)만 복원.

## 7. 두 자산과의 관계 — "얼굴"로서의 위치

```
claudeWIKI  (방법론·파인튜닝 페르소나·측정)   ┐
                                              ├→  BrainStation 2 (인터페이스)
LLM-WIKI    (P-Reinforce 지식 OS·원칙)        ┘
```

- P-Reinforce의 불변식(Raw 불변, canonical/derived, 이벤트 로그, 수동 승인)을 런타임 규칙으로 채택.
- claudeWIKI의 측정 루프(RAGAS 방법론)를 `eval/`로, 페르소나 자산을 `personas.js`와
  로컬 모델 전환 경로로 채택.
- 지식 워크스페이스를 LLM-WIKI 같은 private 저장소에 두면
  (`WORKSPACE_ROOT=/path/to/my-knowledge-repo`) `npm run checkpoint`가 git 커밋을 만든다 —
  "세션은 임시, 지식은 커밋으로 영속화"의 자동화.

## 8. 의도적으로 하지 않은 것

- **클라우드 DB(Firestore) 재도입** — 10년 소유권은 파일 + git이 가장 검증된 경로다.
  필요해지면 `src/storage/` 인터페이스 뒤에 어댑터로 추가한다 (코어 무수정).
- **GC 자동 삭제** — 중복/고아/만료는 보고서까지만. 삭제는 인간의 결정.
- **화려한 그래프 시각화** — 엣지 데이터가 먼저 쌓여야 한다. 노트 상세의 연결 목록으로 시작.
- **업적/뱃지 시스템** — XP·레벨만 유지. 복잡도 대비 가치가 낮았다.

## 9. Reflection Rule (로드맵 전환 전 자문)

1. 내구성이 없는데 있다고 가정하는 것은? 2. 무엇이 지식을 조용히 덮어쓸 수 있는가?
3. provider가 사라지면 복구 불가능한 것은? 4. 10년 사용자가 초기 설계를 후회할 지점은?

하나라도 답이 불편하면 그 단계는 완료가 아니다.
