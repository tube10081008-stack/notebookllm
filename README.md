# 🧠 BrainStation 3 (notebookllm v3)

> **모델은 소비재, 데이터는 자산.**
> 10년간 지식을 쌓아도 후회하지 않도록 설계된, 로컬 우선(local-first) NotebookLM 스타일 지식 스테이션.

claudeWIKI(방법론·페르소나·측정)와 LLM-WIKI/P-Reinforce(지식 OS 원칙)의 **"얼굴"** 역할을 하는 인터페이스입니다.
설계 근거 전체는 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)를 보세요 — v1의 어떤 문제를 어떻게 고쳤는지 13개 항목으로 기록되어 있습니다.

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
| **질의** | 벡터 검색 + 그래프 확장 + 종합 랭킹 → 인용 달린 답변 (모든 답은 원문까지 역추적 가능). 근거가 관련도 하한선 미달이면 "🌐 일반 지식 혼합" 모드로 전환 |
| **지식 헌장** | 생성 설문(목적/토픽/제외어/신뢰 소스)이 스테이션의 수집·학습 방향이 됨. 거절 사유가 헌장에 학습됨 |
| **수집함(Scout)** | 헌장의 피드 + 답변이 남긴 결핍(gaps)으로 소스를 **자동 제안**. 이미 아는 것은 신규성 게이트가 걸러냄. 승인해야만 지식이 됨 |
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
├── charter.json  지식 헌장 (수집·학습 방향 + 학습된 거절)
├── inbox.json    수집함 (스카우트 제안과 처분 이력)
├── vectors.json  임베딩 (derived — 언제든 재구축 가능)
├── chats.jsonl   대화 아카이브 (append-only)
├── gaps.jsonl    답변이 드러낸 지식 결핍 (Scout의 수요 신호)
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

## 수집함 사용법 (자동 제안 파이프라인)

1. 스테이션 생성 설문에서 **지식 헌장**(목적·토픽·제외어·신뢰 소스 RSS/Atom)을 작성
   - arXiv: `http://export.arxiv.org/api/query?search_query=all:RAG&max_results=20`
   - YouTube 채널: `https://www.youtube.com/feeds/videos.xml?channel_id=<채널ID>`
2. 수집함 탭 → **스카우트 실행**: 피드 수집 → 제외어/토픽/결핍 매칭 → 신규성 검사 → 상한 내 제안
3. 제안을 **승인**하면 그때 지식화(원문 보존→증류→그래프), **거절**하면 사유가 헌장에 학습
4. 질문을 많이 할수록 답변의 `gaps`가 쌓여 스카우트가 **내 결핍을 채우는 방향**으로 정교해집니다

## Vercel 배포 — 미리보기 모드 ⚠️

서버리스에서는 파일시스템이 영속되지 않으므로 Vercel 배포는 **체험/데모용 미리보기 모드**입니다
(지식은 `/tmp`에 저장되어 인스턴스 재활용 시 사라짐 — UI에 경고 배너 표시).
**10년 데이터의 본진은 반드시 로컬 실행 + git 워크스페이스입니다.**

```bash
# 내 PC에서 (저장소 루트):
npx vercel                      # 로그인 + 프로젝트 연결
npx vercel env add GEMINI_API_KEY   # LLM 키
npx vercel env add AUTH_TOKEN       # ★ 필수 — 없으면 API가 아예 열리지 않음 (503)
npx vercel --prod
```

- 공개 URL에서 `AUTH_TOKEN` 미설정 시 모든 API가 503으로 잠깁니다 (v1의 무인증 공개 사고 재발 방지).
- 접속하면 브라우저가 토큰을 물어보고 localStorage에 저장합니다.

## 보안

- `AUTH_TOKEN`을 설정하면 모든 API에 Bearer 토큰이 필요합니다. **localhost 밖으로 노출한다면 필수.**
- 기본 바인딩은 `127.0.0.1` — 외부 노출은 명시적 선택입니다.
- 개인 데이터(`data/`, `workspace/`)와 시크릿(`.env`)은 gitignore되어 코드 저장소에 커밋되지 않습니다.
- URL 수집은 사설망을 차단합니다(SSRF). 사내망 피드가 필요할 때만 `ALLOW_PRIVATE_NET=1` (공개 서버 금지).
- 관련도 하한선은 `RELEVANCE_FLOOR`(기본 0.45)로 조정 — 바꾸면 `npm run eval`로 검증하세요.

## 명령어 요약

| 명령 | 역할 |
| --- | --- |
| `npm run dev` | 서버 시작 |
| `npm run eval` | 검색 품질 실측 (LLM-free) |
| `npm run reindex` | 임베딩 전량 재구축 (모델 교체 시) |
| `npm run migrate:v1` | v1 데이터 이관 |
| `npm run checkpoint` | 지식 워크스페이스 git 커밋 |
