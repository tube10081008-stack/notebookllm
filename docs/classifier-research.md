# 콘텐츠 분류기 — 실패 모드 연구 및 수정

> 방법: 논문 근거 → 가설 → 실측 증명 → 로직 수정 → 재측정. "느낌이 아니라 숫자로."
> 대상: `src/core/distill.js`의 `classifyContent` (수집 시 concept/reference/hybrid 자동 판단)

## 근거 논문 5편

1. **Kessler, Nunberg & Schütze (1997), "Automatic Detection of Text Genre"** (arXiv cmp-lg/9707002)
   — 장르는 "표면 단서(surface cues)의 묶음"이며 얕은 단서로도 탐지 가능하지만, *단서는 장르와 상관될 뿐 결정하지 않는다*. → **단일 표면 피처(짧은 줄 비율)는 장르를 혼동시킨다.**

2. **Stamatatos, Fakotakis & Kokkinakis (2000), "Automatic Text Categorization in Terms of Genre and Author"** (ACL J00-4001)
   — 텍스트 내부 피처는 *여러 종류를 조합*해야 판별력이 생긴다. → **한 축(줄 길이)만으로는 부족, 직교 피처가 필요.**

3. **Ramakrishnan et al. (2012), "Layout-aware text extraction from full-text PDF" (LA-PDFText)** (Source Code Biol Med 7:7) + 업계 정리 "What's so Hard about PDF Text Extraction"
   — PDF는 텍스트를 *읽기 순서가 아니라 드로잉 명령*으로 저장. 추출 시 **문장이 물리적 줄로 파편화**되고 블록 경계가 깨진다. → **PDF 산문은 줄바꿈 아티팩트로 "짧은 줄 목록"처럼 보인다.** (본 시스템에서 실제 관측된 오류의 직접 원인.)

4. **Villena-Román et al. (2011), "Hybrid Approach Combining Machine Learning and a Rule-Based Expert System for Text Categorization"** (AAAI)
   — 규칙 기반은 변이에 취약(brittle). 규칙 + 학습기 **하이브리드**가 위양성/위음성을 걸러낸다. → **순수 휴리스틱은 깨진다. 애매한 경계 케이스는 다른 판단기(LLM)로 넘겨라.**

5. **Zhu et al. (2024), "LLM Confidence Evaluation Measures in Zero-Shot Classification"** (arXiv 2410.13047) + "Calibrating Verbalized Probabilities for LLMs" (2410.06707)
   — LLM은 스케일이 커질수록 *더 자신만만하지만 더 틀리기도* 한다. 신뢰도/보정과 임계값이 중요. → **LLM 폴백은 만능이 아니다. 통제된 라벨 집합 + 애매한 구간에만 제한 호출로 비용·오류를 묶어라.**

## 가설 (실패 모드)

| # | 가설 | 근거 |
| --- | --- | --- |
| H1 | PDF/줄바꿈으로 파편화된 산문은 문장종결 비율↓·짧은줄↑ → **reference로 오분류** | 논문 3 |
| H2 | 줄 단위 "문장 종결" 단서는 파편화·서식에 취약 (전역이 아니라 지역 측정이라서) | 논문 1,3 |
| H3 | 짧은줄 비율 단일 피처는 "짧은 항목 목록"과 "줄바꿈 산문"을 혼동 | 논문 1,2 |
| H4 | 산문+표가 섞인 문서는 hybrid여야 하나, H1로 산문 신호가 눌리면 reference로 붕괴 | 논문 2,3 |
| H5 | (설계 제약) LLM 폴백은 애매 구간에만·통제 라벨로 제한해야 비용·과신 오류를 막음 | 논문 4,5 |
| — | (실측 중 발견) 한국어 뜻풀이 종결 `-다/요`가 문장으로 오인되어 단어 리스트가 hybrid로 오분류 | 논문 1 (단서 취약성) |

## 실측 — BEFORE (v1 휴리스틱)

라벨링 코퍼스 7개(`scripts/test-classify.js`) 실행 결과:

```
정확도: 4/7 (57%)
❌ C2 산문(45자 강제 줄바꿈)    concept → reference   [H1 증명]
❌ C3 단어 리스트              reference → hybrid    [한국어 -다 종결 오인]
❌ C7 학술논문 PDF(산문+도표)   hybrid → reference    [H1+H4 실제 사례]
```

→ **H1·H3·H4 모두 재현됨. v1은 줄 단위 지역 측정에 의존해 파편화에 취약.**

## 수정 방향 (논문 처방의 구현)

1. **전역·직교 피처** (논문 1,2 / H2·H3):
   - 문장 신호를 *줄 단위*가 아니라 *전역 문장종결 밀도*(100단어당 종결부호 수)로 측정 → 줄바꿈에 불변.
   - 한국어 종결은 *충분히 긴 줄 끝*일 때만 인정 → 짧은 뜻풀이("사랑하다") 오인 방지.
   - 목록 신호는 *연속 항목 줄의 최장 런(run)* — 산문은 종결부호가 런을 끊어 런이 짧고, 진짜 목록은 런이 길다.

2. **신뢰도 + LLM 폴백** (논문 4,5 / H4·H5):
   - 휴리스틱이 확신하는 경우(순수 산문=긴 줄·높은 밀도 / 순수 목록=밀도 0)만 즉시 결정.
   - **애매 구간**(밀도도 있고 짧은 줄도 많은 = 줄바꿈 산문 vs 표 낀 문서)만 LLM에 {concept|reference|hybrid} 통제 분류로 위임.
   - LLM 미가용(오프라인/mock) 시 안전 기본값 = hybrid(둘 다 보존 → 데이터 무손실).

## 실측 — AFTER (v2: 전역 밀도 + 줄 재결합 + LLM 폴백)

```
휴리스틱 단독 정확도: 7/7 (100%)   ← BEFORE 4/7 (57%)
LLM 폴백 포함 정확도: 7/7 (100%)
```

| 케이스 | BEFORE | AFTER | 무엇이 고쳤나 |
| --- | --- | --- | --- |
| C2 산문(줄바꿈) | ❌ reference | ✅ concept | **줄 재결합** — wrap된 긴 줄을 논리 문장으로 복원 (H1) |
| C3 단어 리스트 | ❌ hybrid | ✅ reference | 한국어 종결은 ≥16자 줄에서만 인정 (뜻풀이 오인 제거) |
| C7 학술 PDF | ❌ reference | ✅ hybrid | 전역 문장밀도로 산문 신호 복원 + 도표 런 감지 (H1+H4) |

### 각 가설의 처분
- **H1 (PDF 파편화)** — 해소. 전역 문장종결 밀도(줄바꿈 불변) + 줄 재결합.
- **H2 (지역 문장단서 취약)** — 해소. 문장 신호를 줄 단위 → 전역 측정으로 전환.
- **H3 (단일 피처 혼동)** — 해소. 밀도·항목런·구분자 3축 조합 + 한국어 종결 길이 게이트.
- **H4 (표 낀 문서 붕괴)** — 해소. 산문 밀도와 항목 런을 함께 보아 hybrid 판정.
- **H5 (LLM 폴백 통제)** — 반영. 애매 구간(conf 0.4)만 LLM에 {concept|reference|hybrid}
  통제 분류로 위임. 확신 구간(conf 0.9)은 LLM을 부르지 않아 비용 통제. LLM 미가용 시
  안전 기본값 = hybrid(무손실). C5·C7은 여전히 애매 표시되나 오프라인 기본값도 정답.

### 남은 한계 (정직한 기록)
- 줄 재결합의 28자 임계는 문서 wrap 폭에 대한 가정. 아주 긴 항목(≥28자)의 목록은
  병합될 수 있으나, 종결부호가 없어 여전히 reference로 수렴 → 무손실.
- 진짜 경계(리치 항목 목록 vs 짧은 문단 산문)는 구조만으로 결정 불가 → 설계상 LLM 위임.
  이는 회피가 아니라 논문 4·5가 처방한 올바른 분업이다.

