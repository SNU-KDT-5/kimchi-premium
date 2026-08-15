const DEFAULT_API_TIMEOUT_MS = 15000;

// KRW-USDT 업비트 상장일. 이 날짜 이전 데이터는 존재하지 않는다.
const USDT_LISTING_DATE = '2024-06-07';

// 업비트 일봉 API는 요청 1건당 최대 200개까지만 반환한다.
// 그래서 to 파라미터로 과거 방향 페이지네이션이 필요하다.
const UPBIT_MAX_COUNT = 200;
const UPBIT_MAX_PAGES = 30;
const UPBIT_PAGE_DELAY_MS = 150;

const CACHE_KEY = 'kimchi-premium-cache';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30분

function toIsoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_API_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildFallbackSeries(startDate = USDT_LISTING_DATE) {
  const today = new Date();
  const start = new Date(`${startDate}T00:00:00Z`);
  const days = Math.max(30, Math.round((today - start) / 86400000));
  const dates = [];
  const usdtPrice = [];
  const fxRate = [];
  const baseFx = 1380;

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const t = (days - i) / days;
    const seasonal = Math.sin((i / 12.5)) * 0.025;
    const wave = Math.sin((i / 38) + 1.7) * 0.02;
    const drift = 0.008 + (t * 0.01);
    const premiumMove = seasonal + wave + drift;
    const fx = baseFx * (1 + (Math.sin(i / 22) * 0.03) + (Math.cos(i / 73) * 0.015));
    const usdt = fx * (1 + premiumMove);

    dates.push(toIsoDate(d));
    usdtPrice.push(Number(usdt.toFixed(0)));
    fxRate.push(Number(fx.toFixed(0)));
  }

  return { dates, usdtPrice, fxRate };
}

// 업비트 일봉을 상장일까지 거슬러 올라가며 전부 받아온다.
// to 파라미터는 배타적(exclusive)이라, 직전 응답의 가장 오래된 캔들 시각을
// 그대로 넘기면 중복 없이 그 이전 구간이 이어서 온다.
async function fetchUpbitSeries(startDate = USDT_LISTING_DATE) {
  const rows = new Map();
  let to = null;

  for (let page = 0; page < UPBIT_MAX_PAGES; page++) {
    const params = `market=KRW-USDT&count=${UPBIT_MAX_COUNT}`;
    const url = `https://api.upbit.com/v1/candles/days?${params}${to ? `&to=${encodeURIComponent(to)}` : ''}`;
    const candles = await fetchJson(url);

    if (!Array.isArray(candles) || candles.length === 0) {
      break;
    }

    candles.forEach((c) => {
      const date = (c.candle_date_time_kst || c.candle_date_time_utc || '').slice(0, 10);
      const price = Number(c.trade_price);
      if (date && Number.isFinite(price)) {
        rows.set(date, price);
      }
    });

    const oldest = candles[candles.length - 1].candle_date_time_utc;

    // 더 이상 진전이 없거나(무한루프 방지), 상장일에 도달했거나,
    // 한 페이지를 다 못 채웠으면 끝까지 받은 것이다.
    if (!oldest || oldest === to) break;
    if (oldest.slice(0, 10) <= startDate) break;
    if (candles.length < UPBIT_MAX_COUNT) break;

    to = oldest;
    await sleep(UPBIT_PAGE_DELAY_MS);
  }

  const sorted = [...rows.entries()]
    .filter(([date]) => date >= startDate)
    .sort((a, b) => a[0].localeCompare(b[0]));

  if (sorted.length === 0) {
    throw new Error('업비트 데이터가 비어 있습니다.');
  }

  return {
    dates: sorted.map((row) => row[0]),
    usdtPrice: sorted.map((row) => row[1])
  };
}

async function fetchFxSeries(startDate, endDate) {
  const url = `https://api.frankfurter.dev/v1/${startDate}..${endDate}?from=USD&to=KRW`;
  const payload = await fetchJson(url);

  if (!payload || !payload.rates) {
    throw new Error('환율 데이터 응답이 비어 있습니다.');
  }

  const map = new Map();
  Object.entries(payload.rates).forEach(([dateKey, row]) => {
    const rate = Number(row.KRW);
    if (Number.isFinite(rate) && rate > 0) {
      map.set(dateKey, rate);
    }
  });

  return map;
}

function findNearestFxRate(dateKey, fxMap) {
  const target = new Date(`${dateKey}T00:00:00Z`);

  for (let offset = 0; offset <= 10; offset++) {
    const d = new Date(target);
    d.setUTCDate(target.getUTCDate() - offset);
    const key = toIsoDate(d);
    const value = fxMap.get(key);
    if (Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!cached || !Array.isArray(cached.dates) || cached.dates.length === 0) return null;
    if (Date.now() - cached.fetchedAt > CACHE_TTL_MS) return null;
    return cached;
  } catch (error) {
    return null;
  }
}

function writeCache(payload) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch (error) {
    // 저장 실패(용량 초과 등)는 조용히 넘어간다. 캐시는 부가 기능일 뿐이다.
  }
}

// 상장일부터 오늘까지의 USDT 종가 + 원/달러 환율을 반환한다.
// 반환값에 fetchedAt(갱신 시각, ms)과 isFallback(샘플 데이터 여부)이 함께 들어간다.
async function getUsdtPremiumData({ startDate = USDT_LISTING_DATE, forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = readCache();
    if (cached) return cached;
  }

  try {
    const upbitData = await fetchUpbitSeries(startDate);
    const start = upbitData.dates[0];
    const end = upbitData.dates[upbitData.dates.length - 1];
    const fxMap = await fetchFxSeries(start, end);

    // 환율을 못 찾은 날은 통째로 실패시키지 않고 그 날짜만 제외한다.
    // (일부 구간이 비어도 나머지는 실데이터로 보여주는 편이 낫다)
    const dates = [];
    const usdtPrice = [];
    const fxRate = [];
    const skipped = [];

    upbitData.dates.forEach((dateKey, i) => {
      const rate = findNearestFxRate(dateKey, fxMap);
      if (rate === null) {
        skipped.push(dateKey);
        return;
      }
      dates.push(dateKey);
      usdtPrice.push(upbitData.usdtPrice[i]);
      fxRate.push(rate);
    });

    if (dates.length === 0) {
      throw new Error('환율과 겹치는 날짜가 하나도 없습니다.');
    }
    if (skipped.length > 0) {
      console.warn(`환율을 찾지 못해 제외한 날짜 ${skipped.length}건 (예: ${skipped.slice(0, 3).join(', ')})`);
    }

    const result = {
      dates,
      usdtPrice,
      fxRate,
      fetchedAt: Date.now(),
      isFallback: false
    };

    writeCache(result);
    return result;
  } catch (error) {
    console.warn('실제 데이터 불러오기 실패, 샘플 데이터로 대체합니다:', error);
    const fallback = buildFallbackSeries(startDate);
    return { ...fallback, fetchedAt: Date.now(), isFallback: true };
  }
}

function clearPremiumCache() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch (error) {
    // no-op
  }
}

window.getUsdtPremiumData = getUsdtPremiumData;
window.clearPremiumCache = clearPremiumCache;
window.USDT_LISTING_DATE = USDT_LISTING_DATE;