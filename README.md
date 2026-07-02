# 🧠 BrainStation 2 (notebookllm v2)

> **모델은 소비재, 데이터는 자산.**
> 10년간 지식을 쌓아도 후회하지 않도록 설계된, 로컬 우선(local-first) NotebookLM 스타일 지식 스테이션.

claudeWIKI(방법론·페르소나·측정)와 LLM-WIKI/P-Reinforce(지식 OS 원칙)의 **"얼굴"** 역할을 하는 인터페이스입니다.
설계 근거 전체는 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)를 보세요 — v1의 어떤 문제를 어떻게 고쳤는지 12개 항목으로 기록되어 있습니다.

---

## 빠른 시작

```bash
npm install
cp .env.example .env        # GEMINI_API_KEY 입력 (또는 LLM_PROVIDER=mock으로 키 없이 체험)
npm run dev                 # → http://localhost:3456
```

## 핵심 개념

| 개념 | 설명 |
| --- | --- |
| **스테이션** | 주제별 지식 공간. 각각 전담 페르소나 에이전트(루나·맥스·아리·소피·카이·리오)를 가짐 |
| **수집 → 증류** | 텍스트/URL/PDF/YouTube/이미지 → 원문 불변 보관 → 원자적 노트로 분해 |
| **그래프** | 노트 간 관계(supports/contradicts/derived_from...)가 수집 시 자동 제안됨 |
| **질의** | 벡터 검색 + 그래프 확장 + 종합 랭킹 → 인용 달린 답변 (모든 답은 원문까지 역추적 가능) |
| **협의회** | 모든 스테이션의 에이전트가 각자의 지식으로 동시에 답변 |
| **정원(GC)** | 중복·고아·만료·모순 후보를 **보고서로만** 제안. 삭제는 항상 사용자의 결정 |
| **타임라인** | 모든 상태 변화의 append-only 감사 로그 |

## 데이터는 어디에 있나 — 10년 규칙

지식은 코드와 완전히 분리된 `WORKSPACE_ROOT`(기본 `./data`)에 **사람이 읽을 수 있는 JSON/JSONL**로 저장됩니다.
이 서비스가 사라져도 텍스트 에디터만으로 지식을 온전히 회수할 수 있습니다.

```
WORKSPACE_ROOT/stations/<id>/
├── raw/        원문 (불변 — 시스템이 절대 수정하지 않음)
├── notes/      원자적 노트 (canonical)
├── graph.json  관계 엣지
├── vectors.json  임베딩 (derived — 언제든 재구축 가능)
├── chats.jsonl   대화 아카이브 (append-only)
└── events.jsonl  감사 로그 (append-only)
```

**권장:** 워크스페이스를 별도 private git 저장소로 만들고 주기적으로 체크포인트하세요.

```bash
cd <WORKSPACE_ROOT> && git init   # 최초 1회
npm run checkpoint                # 변경 요약 커밋 생성 (push는 직접)
```

## 로컬 오픈모델로 전환 (최종 목표)

임시로 빌려 쓰는 API에서 내 모델로 갈아타는 절차:

```bash
# 1단계 — 답변 생성부터 (벡터와 무관, 즉시 전환 가능)
LLM_PROVIDER=openai
LLM_BASE_URL=http://localhost:11434/v1     # Ollama
LLM_TEXT_MODEL=<파인튜닝한 Jay/코라 GGUF>

# 2단계 — 임베딩 (전량 재인덱싱 필요)
LLM_EMBED_MODEL=bge-m3
npm run reindex     # notes(canonical)에서 vectors(derived) 재구축
npm run eval        # 전환 전후 검색 품질을 숫자로 비교!
```

## 검색 품질 측정 — "느낌이 아니라 숫자로"

```bash
cp eval/golden.example.jsonl eval/golden.jsonl   # 내 데이터 기준 골든셋 작성
npm run eval                                     # Hit@1 / Recall@5 / MRR
```

랭킹 가중치·임베딩 모델·그래프 확장을 바꿀 때마다 실행해 회귀를 확인하세요.

## v1 데이터 이관

```bash
npm run migrate:v1 -- /path/to/v1/data   # 노트·엣지 이관 (_dup_ 잔재 자동 제외)
npm run reindex                          # 현재 임베딩 모델로 벡터 재구축
```

## 보안

- `AUTH_TOKEN`을 설정하면 모든 API에 Bearer 토큰이 필요합니다. **localhost 밖으로 노출한다면 필수.**
- 기본 바인딩은 `127.0.0.1` — 외부 노출은 명시적 선택입니다.
- 개인 데이터(`data/`, `workspace/`)와 시크릿(`.env`)은 gitignore되어 코드 저장소에 커밋되지 않습니다.

## 명령어 요약

| 명령 | 역할 |
| --- | --- |
| `npm run dev` | 서버 시작 |
| `npm run eval` | 검색 품질 실측 (LLM-free) |
| `npm run reindex` | 임베딩 전량 재구축 (모델 교체 시) |
| `npm run migrate:v1` | v1 데이터 이관 |
| `npm run checkpoint` | 지식 워크스페이스 git 커밋 |
