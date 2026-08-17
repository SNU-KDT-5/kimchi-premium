# Dashboard
 
김치프리미엄(USDT) 실시간 대시보드입니다. 순수 HTML/CSS/JS로 구현했고, 서버 없이 GitHub Pages에서 정적으로 서빙됩니다.
 
## 핵심 파일
 
| 파일 | 역할 |
|---|---|
| `dashboard.html` | 대시보드 페이지 전체(마크업+스타일+로직 인라인). 구획1(현재 지표: 실시간 카드, 시계열, 게이지·히트맵), 구획2(환율 리스크: 두 선 비교, 브릿지 차트)로 구성. 새로고침 버튼, 로딩/에러 상태 처리 포함 |

 
## 데이터 파일
 
| 파일 | 역할 |
|---|---|
| `naver_trend.json` | 네이버 검색어 트렌드(테더, 김치프리미엄) 결과 스냅샷. `fetch_naver_trend.py`가 생성, `dashboard.html`이 정적 파일로 직접 fetch |
 
## 배치 스크립트
 
| 파일 | 역할 |
|---|---|
| `fetch_naver_trend.py` | 네이버 API HUB를 호출해 검색어 트렌드를 받아 `naver_trend.json`으로 저장. 실시간 필요 없는 일 단위 데이터라 서버 대신 배치 방식 채택 — 키가 브라우저에 노출되지 않음 |
 
## 자동화
 
| 파일 | 역할 |
|---|---|
| `.github/workflows/naver-trend.yml` | 매일 자동으로 `fetch_naver_trend.py`를 실행하고 결과를 커밋하는 GitHub Actions 워크플로우. 웹에서 수동 실행(`workflow_dispatch`)도 가능. **예약 실행은 `main` 브랜치에서만 동작함** |
 
## 데이터 계산 방식
 
프리미엄 값은 `(usdtPrice - fxRate) / fxRate * 100`으로 계산하며, `backend`의 `update_data.py`와 동일한 공식을 씁니다. 환율은 ECB 영업일만 제공되므로 주말·공휴일은 직전 거래일 값으로 forward-fill 처리합니다.
 
## 왜 서버(FastAPI) 없이 동작하는가
 
업비트·Frankfurter(환율) API는 키 없이 쓸 수 있는 공개 API이고 CORS도 열려 있어, 브라우저(`shared.js`)가 직접 호출해도 안전합니다. 반대로 키가 필요한 네이버 API는 배치+정적 파일 방식으로 우회했습니다. `backend`의 LLM 챗봇처럼 매 요청마다 실시간 응답과 키 보호가 동시에 필요한 경우에만 별도 서버가 필요합니다.
 
