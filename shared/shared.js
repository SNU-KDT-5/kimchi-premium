/* ══════════════════════════════════════════════════════════════
   shared.js — 김치프리미엄 프로젝트 공용 데이터 모듈

   dashboard / stats / news 등 여러 페이지가 같은 원본 데이터를
   같은 형식으로 나눠 쓰기 위한 파일.

   ── 제공 함수 ────────────────────────────────────────────
   getUsdtPremiumData()
       → { dates: [...], usdtPrice: [...], fxRate: [...] }

   getBtcPremiumData()
       → { dates: [...], btcPrice: [...], foreignUsd: [...],
           fxRate: [...], foreignSource: 'Bitstamp' }

   ── 데이터 출처 ──────────────────────────────────────────
   data/history.json 정적 파일 하나에서 읽어온다.
   이 파일은 update_data.py 가 하루 1회 업비트/환율/해외거래소
   API를 직접 호출해 미리 계산해 둔 결과물이다. 브라우저가
   업비트 API를 직접 호출하지 않으므로 사용자가 많아져도
   업비트 rate limit(429)에 걸리지 않는다.

   [data/history.json 형식]
   [
     { "date": "2024-06-07", "usdt_price": 1385.2, "fx_rate": 1382.1,
       "premium_pct": 0.22, "volume": ..., "value": ...,
       "btc_premium_pct": 0.27, "btc_krw_price": 89120000.0,
       "foreignUsd": 62975.97, "foreignSource": "Bitstamp" },
     ...
   ]

   날짜별로 USDT 쪽 필드(usdt_price/fx_rate)나 BTC 쪽 필드
   (btc_krw_price/foreignUsd)가 없는 행이 있을 수 있어(당일 마감
   전 등) 각 함수는 자신에게 필요한 필드가 모두 있는 날짜만 걸러
   반환한다.
   ══════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  var HISTORY_URL = (function () {
    var script = document.currentScript;
    var base = script ? script.src : '';
    return new URL('../data/history.json', base).href;
  })();

  var historyPromise = null;

  // data/history.json 을 한 번만 fetch 해서 재사용한다.
  function loadHistory() {
    if (!historyPromise) {
      historyPromise = fetch(HISTORY_URL)
        .then(function (res) {
          if (!res.ok) {
            throw new Error('history.json 요청 실패: HTTP ' + res.status);
          }
          return res.json();
        })
        .then(function (rows) {
          if (!Array.isArray(rows)) {
            throw new Error('history.json 형식 오류: 배열이 아님');
          }
          return rows;
        })
        .catch(function (err) {
          console.error('shared.js: ' + HISTORY_URL + ' 을(를) 불러오지 못했습니다 —', err);
          historyPromise = null;   // 실패했으니 다음 호출에서 재시도할 수 있게 초기화
          throw err;
        });
    }
    return historyPromise;
  }

  /**
   * 테더(USDT) 데이터.
   * @returns {Promise<{dates:string[], usdtPrice:number[], fxRate:number[]}>}
   */
  function getUsdtPremiumData() {
    return loadHistory().then(function (rows) {
      var filtered = rows.filter(function (r) {
        return r.usdt_price != null && r.fx_rate != null;
      });
      return {
        dates: filtered.map(function (r) { return r.date; }),
        usdtPrice: filtered.map(function (r) { return r.usdt_price; }),
        fxRate: filtered.map(function (r) { return r.fx_rate; })
      };
    });
  }

  /**
   * 비트코인(BTC) 데이터. 해외 시세까지 포함해 김프 계산이 가능하다.
   *
   * btcPriceLow(업비트 장중 저가)는 없는 날은 null이다. 종가만 보면 하루 안에
   * 급락했다 되돌아온 날이 "변화 없는 날"로 보이므로, 그런 날을 설명해야 하는
   * 화면(pattern)에서만 쓰고 나머지는 무시하면 된다.
   * @returns {Promise<{dates:string[], btcPrice:number[], btcPriceLow:(number|null)[],
   *                    foreignUsd:number[], fxRate:number[], foreignSource:string}>}
   */
  function getBtcPremiumData() {
    return loadHistory().then(function (rows) {
      var filtered = rows.filter(function (r) {
        return r.btc_krw_price != null && r.foreignUsd != null && r.fx_rate != null;
      });
      var lastSource = null;
      filtered.forEach(function (r) {
        if (r.foreignSource) lastSource = r.foreignSource;
      });
      return {
        dates: filtered.map(function (r) { return r.date; }),
        btcPrice: filtered.map(function (r) { return r.btc_krw_price; }),
        btcPriceLow: filtered.map(function (r) {
          return r.btc_krw_low != null ? r.btc_krw_low : null;
        }),
        foreignUsd: filtered.map(function (r) { return r.foreignUsd; }),
        fxRate: filtered.map(function (r) { return r.fx_rate; }),
        foreignSource: lastSource
      };
    });
  }

  global.getUsdtPremiumData = getUsdtPremiumData;
  global.getBtcPremiumData = getBtcPremiumData;

})(typeof globalThis !== 'undefined' ? globalThis : window);
