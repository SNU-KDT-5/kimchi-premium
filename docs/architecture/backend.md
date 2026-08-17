# Backend

김치프리미엄 데이터를 설명해주는 챗봇 API 서버입니다. FastAPI + Gemini API로 구현했습니다.

## 핵심 파일

| 파일 | 역할 |
|---|---|
| `main.py` | FastAPI 서버. `POST /api/chat` 엔드포인트 제공. Gemini API 연동, 세션당 10회/일일 100회 호출 제한, 투자조언 금지 가드레일 포함 |
| `update_data.py` | 배치 스크립트. 업비트 + Frankfurter 환율 API를 호출해 실제 데이터를 계산하고 `data/current.json`, `data/history.json`을 갱신 |
| `requirements.txt` | 설치해야 할 파이썬 패키지 목록 |
| `.env.example` | 환경변수 형식 예시 (실제 키는 미포함, `.env`는 git에 올라가지 않음) |
| `.gitignore` | git에 올리면 안 되는 파일 목록 (`.env`, `.venv` 등) |

## 데이터 파일

| 파일 | 역할 |
|---|---|
| `data/current.json` | 챗봇이 참고하는 오늘자 스냅샷. `premium_pct`, `fx_rate`, `percentile`, `recent_event` 4개 필드 |
| `data/history.json` | USDT 상장일(2024-06-07) 이후 전체 기간 시계열 데이터. `percentile` 계산의 기준이 됨 |
| `data/events.json` | 팀이 정리한 뉴스 이벤트 목록. `recent_event` 필드에 최근 7일 이내 이벤트가 매칭되어 사용됨 |

## 자동화

| 파일 | 역할 |
|---|---|
| `.github/workflows/update-data.yml` | 매일 자동으로 `update_data.py`를 실행하고 결과를 커밋하는 GitHub Actions 워크플로우. 웹에서 수동 실행(`workflow_dispatch`)도 가능 |

## 데이터 계산 방식

프리미엄 값은 대시보드(`main` 브랜치의 `shared.js`)와 동일한 공식을 사용합니다.
