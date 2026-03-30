# 우리아이갓생 — PoC

> 아이가 RPG 용사가 되어 현실 습관을 퀘스트로 수행하는 서비스의 핵심 가설 검증

## 검증 대상

| 가설 | 피처 | 설명 |
|------|------|------|
| H-1, H-2 | F-001 LLM 세계관 변환 엔진 | 습관→퀘스트 변환 + 세계관 톤 분리 |
| H-3 | F-002 Vector DB 재활용 체인 | 유사 퀘스트 캐싱으로 LLM 호출 절감 |
| H-4 | F-003 안전 필터 | 아동 부적절 표현 차단 |
| — | F-004 통합 API | 위 3개를 연결하는 엔드포인트 |

## 디렉토리 구조

```
poc/
├── src/
│   ├── core/          # F-001: LLM 세계관 변환 엔진
│   ├── vectordb/      # F-002: Vector DB 재활용 체인
│   ├── safety/        # F-003: 안전 필터
│   └── api/           # F-004: 통합 API
├── tests/
│   ├── core/
│   ├── vectordb/
│   ├── safety/
│   └── api/
├── data/
│   ├── worldviews/    # 세계관 바이블 (빛의 왕국, 별빛 마법학교)
│   ├── habits/        # 테스트용 습관 샘플
│   └── evaluations/   # 평가 결과
├── scripts/           # 실행/평가 스크립트
├── configs/           # 설정 파일
└── prd/               # PRD 문서
```

## 시작하기

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 기술 스택

- Python 3.11+
- LLM: OpenAI API (GPT-4o) / Anthropic Claude
- Vector DB: ChromaDB (로컬)
- API: FastAPI
- 테스트: pytest
