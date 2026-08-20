# kimchi-premium

#### Architecture

| 브랜치 | 파일 | 담당 |
|---|---|---|
| `index` | `pages/index/index.html` | 온보딩 (스크롤 인트로) |
| `dashboard` | `pages/dashboard/dashboard.html` | 현황 대시보드 |
| `pattern` | `pages/pattern/pattern.html` | 패턴 분석 |
| `simulator` | `pages/simulator/simulator.html` | 시뮬레이터 (과거 매수 시점 체험 + 리스크체크리스트/계산기/퀴즈) |
| `chatbot` | `chatbot/chatbot-widget.js` | 전역 챗봇 플로팅 위젯 (프런트) |
| `shared` | `shared/shared.js`, `shared/nav.js`, `shared/sound.js` | 공용 데이터 fetch·네비게이션·사운드 |
| `design-system` | `shared/shared.css` | 공용 디자인 시스템 |
| `backend` | `backend/main.py` | FastAPI 김치프리미엄 챗봇 API (Gemini) |

레포 루트 구조:

```
pages/index/       index.html
pages/pattern/     pattern.html
pages/simulator/   simulator.html
pages/dashboard/   dashboard.html
chatbot/     chatbot-widget.js
shared/      shared.css, shared.js, nav.js, sound.js
backend/     main.py, fetch_naver_trend.py, update_data.py,
             requirements.txt, runtime.txt, Procfile, .env.example
assets/      이미지·사운드 등 정적 자산
data/        current.json, history.json, events.json
docs/        아키텍처·프롬프트 문서
naver_trend.json  backend/fetch_naver_trend.py 가 생성하는 데이터 (레포 루트)
```
