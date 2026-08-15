# dashboard 브랜치 작업 프롬프트

담당 페이지: `dashboard.html` (현황 대시보드)

작업을 시작할 때 아래 프롬프트를 그대로 복사해서 Claude Code에 붙여넣고 시작하세요.
(뒤에 이어서 이번에 하고 싶은 구체적인 작업 내용을 덧붙이면 됩니다.)

---

## 복사해서 쓸 프롬프트

```
지금 dashboard 브랜치에서 dashboard.html 작업할 거야. 시작하기 전에 shared.css를 먼저
읽고, 거기 정의된 CSS 변수(색상/spacing/radius)와 클래스(.card, .stat-card, .badge,
.info-card 등)를 최대한 재사용해줘.

지켜야 할 것:
1. 색상은 shared.css의 --frog/--accent/--amber/--text/--mut/--dim 등 변수만 쓰고
   새 색을 임의로 만들지 마. 그린(--frog)은 브랜드 프라이머리로만 쓰고 "매수/하락"
   같은 기능색으로 쓰지 마. "지금 사세요/파세요"처럼 투자 조언으로 읽히는 문구나
   신호등 색 대비(초록=좋음, 빨강=나쁨 식)는 쓰지 마.
2. 인과를 단정하는 문장("A 때문에 B가 됐다") 대신 관찰형 문장("A와 함께 B가 나타났다")
   으로 써줘.
3. spacing/radius는 var(--sp-*), var(--r-*) 토큰만 쓰고 임의 px 값 넣지 마.
4. 상단 네비게이션(.topnav)은 다른 페이지와 완전히 동일한 마크업을 유지하고,
   탭 순서(홈-패턴분석-대시보드-시뮬레이터)와 활성 탭 표시도 그대로 둬.
5. shared.css 자체에 새 컴포넌트를 추가해야 하면, 파일 구조를 바꾸지 말고 맨 아래에
   기존 네이밍 규칙(BEM 느낌)을 따라 추가해줘. 다른 페이지도 같이 쓰는 파일이니까
   기존 클래스는 되도록 건드리지 마.

작업 끝나면 로컬 서버로 직접 열어서 눈으로 확인하고(콘솔 에러 없는지, 모바일 폭에서도
안 깨지는지), git commit 메시지는 "dashboard: 설명" 형식으로 써줘 (feat/style/docs
같은 접두어 말고 브랜치 이름을 접두어로).
```

---

## 지금까지 구현된 것

- ① 현재 지표 (USDT 가격 / 환율 / 프리미엄) + "더 알아보기" 아코디언 (내용은 플레이스홀더)
- ② 환율 분해 (프리미엄 - 환율분 = 실질수익, 계산식 토글)
- ③ 프리미엄 추이 시계열 (90일/1년/3년 탭)
- ④ 두 선 비교 (프리미엄 기준 누적수익 vs 환율 반영 실질 누적수익)
- ⑤ 워터폴 (지금은 "평상시" 사례 하나만)
- ⑥ 투자 안정성 게이지, ⑦ 일별 히트맵 (실질 김프 2년치 백분위 기준)

전부 `seededRandom`으로 만든 데모 데이터. 실제 API 연동은 아직 안 되어 있음.

## 남은 것 (제안)

- `shared.js`의 `getUsdtPremiumData()`가 준비되면 데모 데이터를 실제 데이터로 교체
  (아래 "shared.js 연동 방법" 참고)
- ①의 "더 알아보기" 아코디언 안에 비트코인 거래량/거래대금/네이버 검색지수 등 실제 지표 채우기
- 필요하면 ⑤ 워터폴에 다른 사례를 다시 추가할지 여부 논의 (지금은 "매수/파세요" 뉘앙스
  방지 차원에서 "평상시" 하나로 단순화된 상태)

## shared.js 연동 방법 (`shared` 브랜치 PR 머지되면)

이 페이지는 **USDT 프리미엄**을 다루니까 `getBtcPremiumData()`가 아니라
**`getUsdtPremiumData()`**를 씁니다. (헷갈리기 쉬우니 주의 — pattern.html은 반대로
BTC용 함수를 씁니다.)

1. `<head>`에 `<script src="shared.js"></script>`를 `shared.css` 링크 다음 줄에 추가
   (shared 브랜치 머지 후 `shared.js` 파일이 저장소 루트에 생김. 없으면
   `git checkout shared -- shared.js`로 가져오세요.)

2. 반환 형식은 `{ dates: string[], usdtPrice: number[], fxRate: number[] }`입니다.
   프리미엄%는 직접 계산해야 합니다: `(usdtPrice[i] - fxRate[i]) / fxRate[i] * 100`

3. 지금 데모 데이터를 만드는 함수들(`genPremSeries`, `genCumulativeSeries`, 게이지/
   히트맵의 `realPrems` 생성 루프)을 아래처럼 실제 데이터 기반으로 바꾸면 됩니다.
   차트를 그리는 `drawPremChart`/`drawDecompChart`/게이지·히트맵 렌더링 함수들은
   입력 배열만 맞으면 그대로 재사용 가능합니다 — 굳이 새로 안 짜도 됩니다.

   ```js
   async function loadRealData() {
     const { dates, usdtPrice, fxRate } = await getUsdtPremiumData({ maxYears: 3 });
     const premiumPct = usdtPrice.map((p, i) => (p - fxRate[i]) / fxRate[i] * 100);
     // premiumPct를 genPremSeries()가 반환하던 배열 자리에 그대로 넣으면 됨
   }
   ```

4. **로딩 상태 처리 필수**: API 호출은 비동기(첫 호출 시 최대 몇 초 소요)라
   `shared.css`의 `.status-box`/`.spinner`를 로딩 중 표시에, `.error-box`를 실패
   시 표시에 쓰세요. 페이지 로드 시 바로 빈 차트가 보이지 않게 해주세요.

5. **주말 처리 이슈**: `shared.js`는 현재 업비트(매일)·환율(ECB 영업일만)·해외시세
   데이터를 "모든 소스에 값이 있는 날짜만" 교집합으로 병합합니다 — 즉 **주말이
   자동으로 제외됩니다.** `shared` 브랜치 PR이 아직 머지 안 된 이유가 이 주말 처리
   방식을 바꿀지 말지 결정이 안 나서라고 들었는데, 만약 주말을 채워 넣는 방식으로
   바뀌면 `dates` 배열 길이/간격이 지금과 달라질 수 있으니 merge 시점에 실제 응답
   형태를 한 번 콘솔로 찍어보고 연동하세요.

6. `getUsdtPremiumData()`는 내부적으로 1시간 localStorage 캐시를 씁니다. 데이터가
   이상하게 안 바뀌면 `clearPremiumCache()`로 캐시를 비우고 다시 테스트하세요.
