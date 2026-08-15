/* ══════════════════════════════════════════════════════════════
   shared.js — 김치프리미엄 프로젝트 공용 데이터 모듈

   dashboard / stats / news 등 여러 페이지가 같은 원본 데이터를
   같은 형식으로 나눠 쓰기 위한 파일.
   usdt_premium_dashboard3.html 의 fetch 로직을 분리해 온 것.

   ── 제공 함수 ────────────────────────────────────────────
   getUsdtPremiumData(options?)
       → { dates: [...], usdtPrice: [...], fxRate: [...] }

   getBtcPremiumData(options?)
       → { dates: [...], btcPrice: [...], foreignUsd: [...],
           fxRate: [...], foreignSource: 'Bitstamp' }

   getPremiumData(market, options?)      // 임의의 KRW 마켓
       → { market, dates, price, fxRate, foreignUsd?, foreignSource? }

   clearPremiumCache(market?)            // 캐시 비우기

   ── options (전부 생략 가능) ─────────────────────────────
   force      true면 캐시를 무시하고 API를 다시 호출
   onProgress (n, phase) => {}   phase: 'upbit' | 'foreign' | 'fx'
   maxYears   최대 조회 기간(년). 기본 10

   ── 데이터 출처 ──────────────────────────────────────────
   업비트 일봉    https://api.upbit.com/v1/candles/days
                  한 번에 최대 200개 → to= 커서로 반복 요청
   해외 BTC/USD   https://www.bitstamp.net/api/v2/ohlc/btcusd/
                  실패 시 Coinbase로 자동 전환
   환율(ECB)      https://api.frankfurter.dev/v1/{start}..{end}
                  기간을 한 번에 지정하면 1회 요청으로 전체 반환

   ── 프리미엄 계산법 ──────────────────────────────────────
   BTC   환산가 = foreignUsd[i] * fxRate[i]
         프리미엄% = (btcPrice[i] - 환산가) / 환산가 * 100
   USDT  기준가가 환율 그 자체이므로 해외 시세가 필요 없다
         프리미엄% = (usdtPrice[i] - fxRate[i]) / fxRate[i] * 100

   ── 참고 ─────────────────────────────────────────────────
   · 날짜 키는 UTC 기준(업비트 일봉 경계 UTC 00:00 = KST 09:00).
   · 환율은 ECB 영업일만 제공되므로, 주말·공휴일은 직전 거래일 환율로
     forward-fill 한다. 업비트·해외거래소에 값이 있는 날은 모두 포함.
   · 실제 확보 가능 기간은 업비트 상장일에 막힌다.
     KRW-USDT 2024-06-07~, KRW-BTC 2017-09-25~ (10년치는 불가능)
   ══════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  // ── 설정 ────────────────────────────────────────────────
  var CACHE_PREFIX = 'premiumData:v2:';
  var CACHE_TTL_MS = 60 * 60 * 1000;  // 1시간
  var DEFAULT_MAX_YEARS = 10;

  var UPBIT_BATCH = 200;              // 업비트가 한 번에 주는 최대 개수
  var UPBIT_MAX_LOOPS = 60;           // 200 × 60 = 최대 12,000일치

  var sleep = function (ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  };

  var toDateStr = function (d) { return d.toISOString().split('T')[0]; };

  var tsToDateStr = function (sec) {
    return new Date(sec * 1000).toISOString().split('T')[0];
  };

  // ── 업비트 일봉 전체 히스토리 ──────────────────────────
  // 한 번에 200개만 오므로 to= 커서를 과거로 옮기며 반복 호출한다.
  // 반환: { '2024-06-07': 1385.0, ... }
  async function fetchAllUpbitHistory(market, onProgress, cutoffDateStr) {
    var all = [];
    var to = null;

    for (var i = 0; i < UPBIT_MAX_LOOPS; i++) {
      var url = 'https://api.upbit.com/v1/candles/days?market=' + market +
                '&count=' + UPBIT_BATCH;
      if (to) url += '&to=' + encodeURIComponent(to);

      var res = await fetch(url);
      if (!res.ok) throw new Error('upbit-' + res.status);
      var batch = await res.json();
      if (batch.length === 0) break;          // 상장일 이전 — 더 없음

      all = all.concat(batch);
      if (onProgress) onProgress(all.length, 'upbit');

      var oldest = batch[batch.length - 1];
      var oldestDateStr = oldest.candle_date_time_utc.split('T')[0];

      // 요청 상한(maxYears)보다 과거까지 도달했으면 중단
      if (cutoffDateStr && oldestDateStr <= cutoffDateStr) break;

      // 다음 커서 = 가장 오래된 캔들의 하루 전
      var cursor = new Date(oldest.candle_date_time_utc + 'Z');
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      to = cursor.toISOString().replace('T', ' ').split('.')[0];

      if (batch.length < UPBIT_BATCH) break;  // 마지막 페이지
      await sleep(120);                       // 업비트 요청 제한 회피
    }

    var map = {};
    all.forEach(function (d) {
      var date = d.candle_date_time_utc.split('T')[0];
      if (cutoffDateStr && date < cutoffDateStr) return;
      map[date] = d.trade_price;
    });
    return map;
  }

  // ── Bitstamp BTC/USD 일봉 전체 히스토리 (1차) ──────────
  // 반환: { '2017-09-25': 3900.5, ... }
  async function fetchBitstampBtcHistory(onProgress, cutoffDateStr) {
    var LIMIT = 1000, MAX_LOOPS = 20;
    var all = [];
    var end = Math.floor(Date.now() / 1000);

    for (var i = 0; i < MAX_LOOPS; i++) {
      var url = 'https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=86400' +
                '&limit=' + LIMIT + '&end=' + end;
      var res = await fetch(url);
      if (!res.ok) throw new Error('bitstamp-' + res.status);
      var json = await res.json();
      var ohlc = (json && json.data && json.data.ohlc) ? json.data.ohlc : [];
      if (ohlc.length === 0) break;

      all = all.concat(ohlc);
      if (onProgress) onProgress(all.length, 'foreign');

      var oldestTs = Math.min.apply(null, ohlc.map(function (c) {
        return parseInt(c.timestamp, 10);
      }));
      if (cutoffDateStr && tsToDateStr(oldestTs) <= cutoffDateStr) break;

      end = oldestTs - 86400;
      if (ohlc.length < LIMIT) break;
      await sleep(150);
    }

    var map = {};
    all.forEach(function (c) {
      var date = tsToDateStr(parseInt(c.timestamp, 10));
      if (cutoffDateStr && date < cutoffDateStr) return;
      map[date] = parseFloat(c.close);
    });
    return map;
  }

  // ── Coinbase BTC-USD 일봉 (Bitstamp 실패 시 대체) ──────
  async function fetchCoinbaseBtcHistory(onProgress, cutoffDateStr) {
    var GRAN = 86400, MAX_PER_CALL = 300, MAX_LOOPS = 20;
    var all = [];
    var end = new Date();

    for (var i = 0; i < MAX_LOOPS; i++) {
      var start = new Date(end.getTime() - MAX_PER_CALL * GRAN * 1000);
      var url = 'https://api.exchange.coinbase.com/products/BTC-USD/candles' +
                '?granularity=' + GRAN +
                '&start=' + start.toISOString() + '&end=' + end.toISOString();
      var res = await fetch(url);
      if (!res.ok) throw new Error('coinbase-' + res.status);
      var rows = await res.json();   // [time, low, high, open, close, volume]
      if (!rows || rows.length === 0) break;

      all = all.concat(rows);
      if (onProgress) onProgress(all.length, 'foreign');

      var oldestTs = Math.min.apply(null, rows.map(function (r) { return r[0]; }));
      if (cutoffDateStr && tsToDateStr(oldestTs) <= cutoffDateStr) break;

      end = new Date((oldestTs - GRAN) * 1000);
      if (rows.length < MAX_PER_CALL * 0.5) break;
      await sleep(150);
    }

    var map = {};
    all.forEach(function (r) {
      var date = tsToDateStr(r[0]);
      if (cutoffDateStr && date < cutoffDateStr) return;
      map[date] = r[4];
    });
    return map;
  }

  // Bitstamp 우선, 실패하면 Coinbase로 전환
  async function fetchForeignBtcHistory(onProgress, cutoffDateStr) {
    try {
      var map = await fetchBitstampBtcHistory(onProgress, cutoffDateStr);
      return { map: map, source: 'Bitstamp' };
    } catch (err) {
      console.warn('shared.js: Bitstamp 실패, Coinbase로 전환 —', err.message);
      try {
        var map2 = await fetchCoinbaseBtcHistory(onProgress, cutoffDateStr);
        return { map: map2, source: 'Coinbase' };
      } catch (err2) {
        throw new Error('foreign-btc-both-failed: ' + err.message + ' / ' + err2.message);
      }
    }
  }

  // 마켓별 해외 USD 시세 소스 (없으면 업비트+환율만 사용)
  var FOREIGN_SOURCES = {
    'KRW-BTC': fetchForeignBtcHistory
  };

  // ── Frankfurter(ECB) USD/KRW 환율 히스토리 ─────────────
  // 반환: { '2024-06-07': 1379.5, ... }  (ECB 영업일만 존재)
  async function fetchFxHistory(startDateStr, endDate) {
    var start = new Date(startDateStr);
    start.setDate(start.getDate() - 5);   // 시작일이 휴일일 수 있어 여유분

    var url = 'https://api.frankfurter.dev/v1/' +
              toDateStr(start) + '..' + toDateStr(endDate) +
              '?base=USD&symbols=KRW';

    var res = await fetch(url);
    if (!res.ok) throw new Error('fx-' + res.status);
    var data = await res.json();

    var map = {};
    Object.keys(data.rates).forEach(function (date) {
      map[date] = data.rates[date].KRW;
    });
    return map;
  }

  // ── localStorage 캐시 (1시간) ──────────────────────────
  function readCache(market) {
    try {
      var raw = localStorage.getItem(CACHE_PREFIX + market);
      if (!raw) return null;
      var cached = JSON.parse(raw);
      if (!cached || !cached.savedAt || !Array.isArray(cached.dates)) return null;
      if (Date.now() - cached.savedAt > CACHE_TTL_MS) return null;  // 만료
      return cached;
    } catch (e) {
      return null;   // 손상된 캐시 / localStorage 접근 불가
    }
  }

  function writeCache(market, payload) {
    try {
      localStorage.setItem(CACHE_PREFIX + market, JSON.stringify(payload));
    } catch (e) {
      // 용량 초과나 사생활 보호 모드 — 캐시 없이도 동작하므로 무시
      console.warn('shared.js: 캐시 저장 실패 —', e.message);
    }
  }

  // ── 실제 수집 + 병합 ───────────────────────────────────
  async function loadPremiumData(market, options) {
    var onProgress = options.onProgress;
    var maxYears = options.maxYears || DEFAULT_MAX_YEARS;

    var cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - maxYears);
    var cutoffDateStr = toDateStr(cutoff);

    // 1) 업비트 원화 시세 + 해외 USD 시세 — 서로 독립이므로 동시에 요청
    var results = await Promise.all([
      fetchAllUpbitHistory(market, onProgress, cutoffDateStr),
      FOREIGN_SOURCES[market]
        ? FOREIGN_SOURCES[market](onProgress, cutoffDateStr)
        : Promise.resolve(null)
    ]);

    var localMap = results[0];
    var localDates = Object.keys(localMap).sort();
    if (localDates.length === 0) throw new Error('no-upbit-data:' + market);

    var foreignMap = results[1] ? results[1].map : null;
    var foreignSource = results[1] ? results[1].source : null;

    // 2) 환율 — 업비트 데이터가 있는 기간만큼만 (시작일을 알아야 하므로 나중에)
    if (onProgress) onProgress(0, 'fx');
    var fxMap = await fetchFxHistory(localDates[0], new Date());

    // 3) 주말·공휴일 환율 forward-fill
    //    ECB는 영업일만 제공하므로, 직전 거래일 환율을 빈 날짜에 채운다.
    //    첫 localDate가 주말일 경우를 대비해 앞쪽 여유분(5일 버퍼)도 탐색.
    var filledFxMap = {};
    var lastFx = (function () {
      var fxDates = Object.keys(fxMap).sort();
      var first = localDates[0];
      for (var i = fxDates.length - 1; i >= 0; i--) {
        if (fxDates[i] < first) return fxMap[fxDates[i]];
      }
      return null;
    }());
    localDates.forEach(function (d) {
      if (fxMap[d] !== undefined) lastFx = fxMap[d];
      if (lastFx !== null) filledFxMap[d] = lastFx;
    });

    var dates = localDates.filter(function (d) {
      if (filledFxMap[d] === undefined) return false;
      if (foreignMap && foreignMap[d] === undefined) return false;
      return true;
    });
    if (dates.length === 0) throw new Error('no-overlap:' + market);

    var result = {
      market: market,
      dates: dates,
      price:  dates.map(function (d) { return localMap[d]; }),
      fxRate: dates.map(function (d) { return filledFxMap[d]; })
    };
    if (foreignMap) {
      result.foreignUsd = dates.map(function (d) { return foreignMap[d]; });
      result.foreignSource = foreignSource;
    }
    return result;
  }

  // ── 공개 API ───────────────────────────────────────────
  var inFlight = {};   // 같은 market 동시 호출 시 요청 합치기

  function fromCache(market, cached) {
    var out = {
      market: market,
      dates: cached.dates,
      price: cached.price,
      fxRate: cached.fxRate
    };
    if (cached.foreignUsd) {
      out.foreignUsd = cached.foreignUsd;
      out.foreignSource = cached.foreignSource;
    }
    return out;
  }

  /**
   * 업비트 KRW 마켓 종가 + USD/KRW 환율(+ 해외 USD 시세)을 날짜로 맞춰 반환.
   * @param {string} [market='KRW-USDT'] 예: 'KRW-USDT', 'KRW-BTC'
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  function getPremiumData(market, options) {
    market = market || 'KRW-USDT';
    options = options || {};

    if (!options.force) {
      var cached = readCache(market);
      if (cached) return Promise.resolve(fromCache(market, cached));
    }

    if (inFlight[market]) return inFlight[market];

    inFlight[market] = loadPremiumData(market, options)
      .then(function (result) {
        var payload = {
          savedAt: Date.now(),
          dates: result.dates,
          price: result.price,
          fxRate: result.fxRate
        };
        if (result.foreignUsd) {
          payload.foreignUsd = result.foreignUsd;
          payload.foreignSource = result.foreignSource;
        }
        writeCache(market, payload);
        delete inFlight[market];
        return result;
      })
      .catch(function (err) {
        delete inFlight[market];
        throw err;
      });

    return inFlight[market];
  }

  /**
   * 테더(USDT) 데이터. guide.html 명세 형식.
   * @returns {Promise<{dates:string[], usdtPrice:number[], fxRate:number[]}>}
   */
  function getUsdtPremiumData(options) {
    return getPremiumData('KRW-USDT', options).then(function (r) {
      return { dates: r.dates, usdtPrice: r.price, fxRate: r.fxRate };
    });
  }

  /**
   * 비트코인(BTC) 데이터. 해외 시세까지 포함해 김프 계산이 가능하다.
   * @returns {Promise<{dates:string[], btcPrice:number[], foreignUsd:number[],
   *                    fxRate:number[], foreignSource:string}>}
   */
  function getBtcPremiumData(options) {
    return getPremiumData('KRW-BTC', options).then(function (r) {
      return {
        dates: r.dates,
        btcPrice: r.price,
        foreignUsd: r.foreignUsd,
        fxRate: r.fxRate,
        foreignSource: r.foreignSource
      };
    });
  }

  /** 캐시 비우기 — market 생략 시 전체 */
  function clearPremiumCache(market) {
    try {
      if (market) {
        localStorage.removeItem(CACHE_PREFIX + market);
        return;
      }
      Object.keys(localStorage)
        .filter(function (k) { return k.indexOf(CACHE_PREFIX) === 0; })
        .forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) { /* localStorage 접근 불가 */ }
  }

  global.getUsdtPremiumData = getUsdtPremiumData;
  global.getBtcPremiumData = getBtcPremiumData;
  global.getPremiumData = getPremiumData;
  global.clearPremiumCache = clearPremiumCache;

})(typeof globalThis !== 'undefined' ? globalThis : window);