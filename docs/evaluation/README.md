# F-001 평가 절차 가이드

이 디렉토리는 F-001 LLM 세계관 변환 엔진 PoC의 **수동 평가 템플릿** 및 **절차 안내**를 담고 있다.
평가 기준과 루브릭 상세는 [`rubric.md`](./rubric.md)를 참고한다.

---

## 1. 준비물

| 파일 | 역할 |
|------|------|
| `rubric.md` | 4축 루브릭과 합격 기준 계산 공식 |
| `scoring-template.csv` | 4축 채점 시트 템플릿 (헤더만 포함) |
| `blind-classification-template.csv` | 세계관 블라인드 분류 시트 템플릿 |

---

## 2. 실행 절차

### 2.1 Task 10 — 평가 러너 실행

전체 세계관을 대상으로 100건(습관 50 × 세계관 2)을 생성한다.

```bash
npm run eval:run -- --model=haiku --worldview=all
```

산출물: `data/runs/<timestamp>/run.jsonl` — 각 라인은 `{ run_id, item_id, worldview_id, quest, ... }` 형식.

### 2.2 Task 11 — 블라인드 평가 데이터 생성

세계관 라벨을 제거한 블라인드 평가 세트를 생성한다.

```bash
npm run eval:blind -- --run=<path-to-run.jsonl>
```

산출물: 세계관 라벨이 제거된 퀘스트 목록. 평가자는 `quest_name`과 `description`만 보고 어느 세계관인지 추정한다.

### 2.3 4축 루브릭 채점

1. `scoring-template.csv`를 복사하여 `scoring-<date>.csv`로 저장한다.
2. Task 10 산출물의 각 라인을 행으로 추가한다.
3. 평가자 2명 이상이 `rubric.md` §2.1~§2.4 기준에 따라 점수를 기록한다.
   - `tone_score`, `intent_score`, `age_score`: 1~5 정수
   - `json_parse_ok`: `true` / `false`
4. 의견이 갈리는 건은 `notes` 컬럼에 사유를 남기고 합의 점수로 확정한다.

### 2.4 블라인드 분류 채점

1. `blind-classification-template.csv`를 복사하여 `blind-<date>.csv`로 저장한다.
2. 평가자 2명(작성자 제외)이 독립적으로 `guessed_worldview`와 `confidence`(1~5)를 기입한다.
3. 실제 `worldview_id`와 대조하여 정확도를 계산한다.

---

## 3. 합격 기준 계산 공식

```
합격률(%) = (해당 축에서 3점 이상 기록 수 / 전체 평가 건수) × 100
JSON 파싱 성공률(%) = (json_parse_ok = true 건수 / 전체 평가 건수) × 100
블라인드 구분 정확도(%) = (guessed_worldview = 실제 worldview_id 건수 / 전체 블라인드 평가 건수) × 100
```

- 전체 평가 건수 기준: 100건 (습관 50 × 세계관 2)
- 블라인드 평가 건수 기준: 40건 (습관 20 × 세계관 2, PRD §8.2)

---

## 4. PoC 통과 기준 체크리스트

PRD `prd/prd-f001-llm-engine.md` §8.4 기준. 아래 **모든** 조건을 충족해야 PoC 통과로 판정한다.

- [ ] 톤 일관성 합격률 ≥ 80%
- [ ] 부모 의도 보존 합격률 ≥ 90%
- [ ] 연령 적합성 합격률 ≥ 95%
- [ ] JSON 파싱 성공률 ≥ 98%
- [ ] 세계관 블라인드 구분 정확도 ≥ 90%
- [ ] 경량 모델 평균 응답 시간 < 3초

평균 응답 시간은 Task 8 `MetricsCollector`가 수집한 `latencyMs` 집계값(`summary.avgLatencyMs`)을 사용한다.

---

## 5. 결과 아카이브

채점이 완료되면 결과 파일(`scoring-<date>.csv`, `blind-<date>.csv`)과 요약 메모를
`docs/_local/` 하위에 보관한다. `docs/` 본경로에는 공개 가능한 최종 요약만 이관한다.
