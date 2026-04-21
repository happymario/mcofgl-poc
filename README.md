# 우리아이갓생 — PoC

> 아이가 RPG 용사가 되어 현실 습관을 퀘스트로 수행하는 서비스의 핵심 가설 검증

## 검증 대상

| 가설 | 피처 | 설명 |
|------|------|------|
| H-1, H-2 | F-001 LLM 세계관 변환 엔진 | 습관→퀘스트 변환 + 세계관 톤 분리 |
| H-3 | F-002 Vector DB 재활용 체인 | 유사 퀘스트 캐싱으로 LLM 호출 절감 |
| H-4 | F-003 안전 필터 | 아동 부적절 표현 차단 |
| — | F-004 통합 API | 위 3개를 연결하는 엔드포인트 |

## 기술 스택

- **런타임**: Node.js 22+ / TypeScript 5.7+
- **API 서버**: Fastify 5
- **LLM 오케스트레이션**: LangChain/LangGraph TS + @anthropic-ai/sdk
- **LLM**: Anthropic Claude (Haiku — 실시간, Sonnet — 품질 비교)
- **스키마 검증**: Zod
- **테스트**: Vitest

## 디렉토리 구조

```
poc/
├── src/
│   ├── core/          # F-001: LLM 세계관 변환 엔진
│   │   ├── schemas/   # Zod 스키마 (Quest, Worldview, API)
│   │   ├── prompt/    # 프롬프트 조립 모듈
│   │   └── transformer.ts  # QuestTransformer
│   ├── api/           # F-001: Fastify 엔드포인트
│   ├── eval/          # 평가 파이프라인 (runner, metrics, blind-gen)
│   └── index.ts       # 서버 엔트리포인트
├── tests/
│   ├── core/
│   ├── api/
│   ├── eval/
│   └── data/
├── data/
│   ├── worldviews/    # 세계관 바이블 JSON (빛의 왕국, 별빛 마법학교)
│   ├── habits/        # 테스트용 습관 샘플 (50건)
│   └── evaluations/   # 평가 결과 (git-ignored)
├── scripts/           # 검증 스크립트 (validate-worldviews.ts 등)
├── docs/
│   └── evaluation/    # 수동 평가 루브릭 및 템플릿
└── prd/               # PRD 문서
```

## 시작하기

```bash
# 의존성 설치
npm install

# 환경 변수 설정
cp .env.example .env
# .env에 ANTHROPIC_API_KEY 입력

# 개발 서버 실행
npm run dev

# 테스트 실행
npm test

# 타입 체크
npm run type-check

# 세계관 바이블 검증
npm run validate:worldviews
```

## 평가 실행

```bash
# 100건 변환 평가 (실제 API 호출)
npm run eval:run -- --model=haiku --worldview=all

# 블라인드 테스트 아티팩트 생성
npm run eval:blind -- --run=data/evaluations/run-<timestamp>.json
```
