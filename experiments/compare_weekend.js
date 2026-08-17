/* ══════════════════════════════════════════════════════════════
   compare_weekend.js — 주말 처리 방식 비교 로직
   (shared.js의 fetch 로직을 재사용, 비교 전용으로 분리)

   방식 A: 주말 제외 (fx 없는 날짜는 null → 차트에서 직선으로 건너뜀)
   방식 B: forward-fill (직전 영업일 환율을 주말에도 재사용)
   ══════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  var UPBIT_BATCH = 200;
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var toDateStr = function (d) { return d.toISOString().split('T')[0]; };

  // ── 업비트 일봉 전체 히스토리 (shared.js와 동일 로직) ──
  async function fetchAllUpbit(market, onProgress) {
    var all = [];
    var to = null;
    for (var i = 0; i < 60; i++) {
      var url = 'https://api.upbit.com/v1/candles/days?market=' + market + '&count=' + UPBIT_BATCH;
      if (to) url += '&to=' + encodeURIComponent(to);
      var res = await fetch(url);
      if (!res.ok) throw new Error('upbit-' + res.status);
      var batch = await res.json();
      if (batch.length === 0) break;
      all = all.concat(batch);
      if (onProgress) onProgress(all.length);
      var oldest = batch[batch.length - 1];
      var cursor = new Date(oldest.candle_date_time_utc + 'Z');
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      to = cursor.toISOString().replace('T', ' ').split('.')[0];
      if (batch.length < UPBIT_BATCH) break;
      await sleep(120);
    }
    var map = {};
    all.forEach(function (d) {
      map[d.candle_date_time_utc.split('T')[0]] = d.trade_price;
    });
    return map;
  }

  // ── Frankfurter 환율 (영업일만) ──
  async function fetchFx(startDateStr, endDate) {
    var start = new Date(startDateStr);
    start.setDate(start.getDate() - 5);
    var url = 'https://api.frankfurter.dev/v1/' + toDateStr(start) + '..' + toDateStr(endDate) + '?base=USD&symbols=KRW';
    var res = await fetch(url);
    if (!res.ok) throw new Error('fx-' + res.status);
    var data = await res.json();
    var map = {};
    Object.keys(data.rates).forEach(function (d) { map[d] = data.rates[d].KRW; });
    return map;
  }

  function dayOfWeek(dateStr) {
    return new Date(dateStr + 'T00:00:00Z').getUTCDay(); // 0=일, 6=토
  }
  function isWeekend(dateStr) {
    var d = dayOfWeek(dateStr);
    return d === 0 || d === 6;
  }

  // ── Bitstamp BTC/USD 일봉 (실패 시 Coinbase로 전환) ──
  async function fetchBitstampBtc(onProgress) {
    var LIMIT = 1000, MAX_LOOPS = 20;
    var all = [];
    var end = Math.floor(Date.now() / 1000);
    for (var i = 0; i < MAX_LOOPS; i++) {
      var url = 'https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=86400&limit=' + LIMIT + '&end=' + end;
      var res = await fetch(url);
      if (!res.ok) throw new Error('bitstamp-' + res.status);
      var json = await res.json();
      var ohlc = (json && json.data && json.data.ohlc) ? json.data.ohlc : [];
      if (ohlc.length === 0) break;
      all = all.concat(ohlc);
      if (onProgress) onProgress(all.length);
      var oldestTs = Math.min.apply(null, ohlc.map(function (c) { return parseInt(c.timestamp, 10); }));
      end = oldestTs - 86400;
      if (ohlc.length < LIMIT) break;
      await sleep(150);
    }
    var map = {};
    all.forEach(function (c) {
      map[new Date(parseInt(c.timestamp, 10) * 1000).toISOString().split('T')[0]] = parseFloat(c.close);
    });
    return map;
  }

  async function fetchCoinbaseBtc(onProgress) {
    var GRAN = 86400, MAX_PER_CALL = 300, MAX_LOOPS = 20;
    var all = [];
    var end = new Date();
    for (var i = 0; i < MAX_LOOPS; i++) {
      var start = new Date(end.getTime() - MAX_PER_CALL * GRAN * 1000);
      var url = 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=' + GRAN +
                '&start=' + start.toISOString() + '&end=' + end.toISOString();
      var res = await fetch(url);
      if (!res.ok) throw new Error('coinbase-' + res.status);
      var rows = await res.json();
      if (!rows || rows.length === 0) break;
      all = all.concat(rows);
      if (onProgress) onProgress(all.length);
      var oldestTs = Math.min.apply(null, rows.map(function (r) { return r[0]; }));
      end = new Date((oldestTs - GRAN) * 1000);
      if (rows.length < MAX_PER_CALL * 0.5) break;
      await sleep(150);
    }
    var map = {};
    all.forEach(function (r) {
      map[new Date(r[0] * 1000).toISOString().split('T')[0]] = r[4];
    });
    return map;
  }

  async function fetchForeignBtc(onProgress) {
    try { return await fetchBitstampBtc(onProgress); }
    catch (err) {
      console.warn('Bitstamp 실패, Coinbase로 전환 —', err.message);
      return await fetchCoinbaseBtc(onProgress);
    }
  }

  /**
   * 실제 데이터를 받아 방식 A(주말 제외) / 방식 B(forward-fill) 두 시리즈를 계산.
   * @param {string} market 'KRW-USDT' | 'KRW-BTC'
   * @param {function} onProgress (message: string) => void
   * @returns {Promise<{labels, seriesExclude, seriesFfill, weekendFlags, priceMap, fxMap}>}
   */
  async function buildComparison(market, onProgress) {
    if (onProgress) onProgress('업비트 일봉 불러오는 중...');
    var priceMap = await fetchAllUpbit(market, function (n) {
      if (onProgress) onProgress('업비트 일봉 ' + n + '개 확보...');
    });

    var allDates = Object.keys(priceMap).sort();
    if (allDates.length === 0) throw new Error('업비트 데이터 없음');

    // BTC는 해외 USD 시세가 있어야 정확한 기준가(foreignUsd × fxRate)를 계산할 수 있음.
    // USDT는 1달러에 근접하므로 fxRate 자체를 기준가로 사용.
    var foreignMap = null;
    if (market === 'KRW-BTC') {
      if (onProgress) onProgress('해외 BTC/USD 시세 불러오는 중...');
      foreignMap = await fetchForeignBtc(function (n) {
        if (onProgress) onProgress('해외 BTC/USD ' + n + '개 확보...');
      });
    }

    if (onProgress) onProgress('환율(Frankfurter) 불러오는 중...');
    var fxMap = await fetchFx(allDates[0], new Date());

    var labels = [], seriesExclude = [], seriesFfill = [], weekendFlags = [];
    var lastFx = null, lastForeign = null;

    allDates.forEach(function (d) {
      var price = priceMap[d];
      var weekend = isWeekend(d);
      labels.push(d);
      weekendFlags.push(weekend);

      if (fxMap[d] !== undefined) lastFx = fxMap[d];
      if (foreignMap && foreignMap[d] !== undefined) lastForeign = foreignMap[d];

      // ── 기준가(reference) 계산 ──
      // USDT: 기준가 = fxRate (USDT ≈ $1 이므로)
      // BTC : 기준가 = foreignUsd × fxRate (해외 BTC 달러가 × 환율)
      var refExclude = null, refFfill = null;
      if (market === 'KRW-BTC') {
        if (fxMap[d] !== undefined && foreignMap && foreignMap[d] !== undefined) {
          refExclude = foreignMap[d] * fxMap[d];
        }
        if (lastFx !== null && lastForeign !== null) {
          refFfill = lastForeign * lastFx;
        }
      } else {
        refExclude = fxMap[d] !== undefined ? fxMap[d] : null;
        refFfill = lastFx;
      }

      seriesExclude.push(refExclude !== null ? (price - refExclude) / refExclude * 100 : null);
      seriesFfill.push(refFfill !== null ? (price - refFfill) / refFfill * 100 : null);
    });

    return {
      labels: labels,
      seriesExclude: seriesExclude,
      seriesFfill: seriesFfill,
      weekendFlags: weekendFlags,
      priceMap: priceMap,
      fxMap: fxMap
    };
  }

  /** 금요일 → 다음 유효 데이터 구간의 프리미엄 점프 크기 계산 (방식 A 기준, 상위 N개) */
  function computeFridayJumps(labels, seriesExclude, seriesFfill, topN) {
    var jumps = [];
    for (var i = 0; i < labels.length; i++) {
      if (dayOfWeek(labels[i]) === 5 && seriesExclude[i] !== null) { // 금요일
        var jA = null, nextLabelA = null;
        for (var a = i + 1; a < labels.length; a++) {
          if (seriesExclude[a] !== null) { jA = seriesExclude[a] - seriesExclude[i]; nextLabelA = labels[a]; break; }
        }
        var jB = null;
        if (i + 1 < labels.length && seriesFfill[i + 1] !== null && seriesFfill[i] !== null) {
          jB = seriesFfill[i + 1] - seriesFfill[i];
        }
        if (jA !== null) jumps.push({ from: labels[i], toA: nextLabelA, jumpA: jA, jumpB: jB });
      }
    }
    jumps.sort(function (x, y) { return Math.abs(y.jumpA) - Math.abs(x.jumpA); });
    return jumps.slice(0, topN || 10);
  }

  /** null 구간을 앞뒤 유효값으로 직선보간 (방식 A가 실제 차트에서 "직선으로 건너뛸 때"의 값을 수치화) */
  function linearInterpolate(series) {
    var out = series.slice();
    var n = out.length;
    var i = 0;
    while (i < n) {
      if (out[i] === null) {
        var start = i - 1; // 마지막 유효값 인덱스
        var j = i;
        while (j < n && out[j] === null) j++;
        var end = j; // 다음 유효값 인덱스 (n이면 끝까지 null)
        if (start >= 0 && end < n) {
          var startVal = out[start], endVal = out[end];
          var span = end - start;
          for (var k = i; k < end; k++) {
            out[k] = startVal + (endVal - startVal) * ((k - start) / span);
          }
        }
        i = j;
      } else {
        i++;
      }
    }
    return out;
  }

  global.buildComparison = buildComparison;
  global.computeFridayJumps = computeFridayJumps;
  global.linearInterpolate = linearInterpolate;
  global.isWeekend = isWeekend;
  global.dayOfWeek = dayOfWeek;

})(typeof globalThis !== 'undefined' ? globalThis : window);
