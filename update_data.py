"""김치프리미엄 데이터 배치 갱신 스크립트 (하루 1회 실행, 예: cron).

- 업비트 USDT/KRW 상장일(2024-06-07)부터 오늘까지 전체 일봉 + Frankfurter
  원/달러 환율을 날짜 기준으로 병합해 날짜별 premium_pct를 계산한다.
  (거래량 volume, 거래대금 value도 함께 저장한다.)
- percentile은 "최근 N일"이 아니라 USDT 상장일 이후 전체 기간 데이터 중 오늘
  값의 백분위로 계산한다 (팀 dashboard.html의 pctOf 방식과 동일).
- BTC 프리미엄(btc_premium_pct)도 함께 계산한다: 업비트 KRW-BTC + 해외 BTC/USD
  시세(Bitstamp 우선, 실패 시 Coinbase로 자동 전환) + 환율을 날짜 기준으로
  병합한다. 환율은 주말/공휴일에 발표되지 않으므로 직전 거래일 값으로
  forward-fill해서, USDT 프리미엄과 달리 주말에도 계산되도록 한다.
- USDT와 BTC는 수집 시작일이 다르다. USDT는 상장일인 2024-06-07부터,
  BTC는 그보다 훨씬 이른 2017-09-25부터 모은다. 환율은 둘 중 이른 날짜
  하나를 기준으로 Frankfurter를 딱 한 번만 호출해 양쪽 계산에 함께 쓴다.
- data/history.json에는 두 기간의 합집합을, data/current.json에는 오늘(가장
  최근 날짜) 값만 저장한다. 매 실행마다 전체 기간을 다시 계산해 통째로
  덮어쓰므로 별도의 누적/병합 로직이 필요 없다.
  BTC만 있는 과거 구간(2024-06-07 이전) 행에는 usdt_price/premium_pct 등
  USDT 계열 키를 아예 넣지 않는다. 프런트(shared.js)가 `!= null`로 결측을
  거르므로 키가 없으면 조용히 제외되지만, "N/A" 같은 문자열이나 NaN을 넣으면
  그 필터를 통과해 차트 축 계산이 통째로 깨진다.
- 어느 API든 하나라도 실패하면 기존 data/current.json, data/history.json은
  절대 건드리지 않고 에러 로그만 남긴 뒤 0이 아닌 코드로 종료한다.
"""

import json
import logging
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("update_data")

BASE_DIR = Path(__file__).resolve().parent
CURRENT_JSON_PATH = BASE_DIR / "data" / "current.json"
HISTORY_JSON_PATH = BASE_DIR / "data" / "history.json"
EVENTS_JSON_PATH = BASE_DIR / "data" / "events.json"

UPBIT_CANDLES_URL = "https://api.upbit.com/v1/candles/days"
FRANKFURTER_URL_TEMPLATE = "https://api.frankfurter.dev/v1/{start}..{end}"
BITSTAMP_OHLC_URL = "https://www.bitstamp.net/api/v2/ohlc/btcusd/"
COINBASE_CANDLES_URL = "https://api.exchange.coinbase.com/products/BTC-USD/candles"

USDT_LISTING_DATE = date(2024, 6, 7)
BTC_LISTING_DATE = date(2017, 9, 25)

# 환율은 두 수집 시작일 중 이른 쪽부터 한 번에 받아 USDT/BTC 계산에 공유한다.
# 예전에는 BTC 시세도 USDT_LISTING_DATE부터만 받았는데, 이유는 "그보다 과거
# 구간은 환율이 없어 프리미엄을 계산할 수 없다"는 것이었다(c09f493). Frankfurter는
# 시작일만 앞당기면 같은 요청 하나로 과거 구간까지 함께 주므로, 호출 횟수를
# 늘리지 않고도 그 제약을 없앨 수 있다. 그래서 BTC만 시작일을 앞당겼다.
FX_HISTORY_START_DATE = min(USDT_LISTING_DATE, BTC_LISTING_DATE)

UPBIT_PAGE_SIZE = 200
# 무한 루프 방지용 상한. BTC를 2017-09-25부터 받으면 3,200일 ≈ 17페이지가 필요해
# 기존 상한 20으로는 2년쯤 뒤 조용히 잘리기 시작한다. 20년치 여유를 둔다.
MAX_UPBIT_PAGES = 40
UPBIT_REQUEST_DELAY_SECONDS = 0.15  # 페이지 간 대기 (요청 제한 회피)

MAX_FOREIGN_BTC_PAGES = 20  # 무한 루프 방지용 상한
FOREIGN_REQUEST_DELAY_SECONDS = 0.15  # 페이지 간 대기 (요청 제한 회피)

RECENT_EVENT_WINDOW_DAYS = 7
REQUEST_TIMEOUT_SECONDS = 10


class DataFetchError(Exception):
    """외부 API 호출/파싱 실패, 혹은 병합 가능한 데이터가 없을 때 발생시킨다."""


class _ForeignFetchError(Exception):
    """해외 BTC 시세 소스 하나(Bitstamp 또는 Coinbase)가 실패했을 때만 쓰는
    내부 예외. fetch_foreign_btc_usd_history()가 이걸 잡아서 다음 소스로
    자동 전환(폴백)하는 데 쓴다."""


def _fetch_upbit_daily_candles(market: str, listing_date: date) -> list:
    """업비트에서 listing_date부터 오늘까지의 전체 일봉 원본 캔들 리스트를
    최신순으로 반환한다 (원본 dict 그대로, 필드 파싱은 호출자가 한다).

    한 번에 최대 UPBIT_PAGE_SIZE개(200개)만 오므로, to= 커서를 이전 페이지의
    가장 오래된 캔들 시각으로 옮겨가며 반복 호출한다. 상장일에 도달하거나
    MAX_UPBIT_PAGES 횟수에 도달하면 멈춘다.
    """
    candles_all: list = []
    cursor_to = None
    listing_date_str = listing_date.isoformat()

    for page in range(1, MAX_UPBIT_PAGES + 1):
        params = {"market": market, "count": UPBIT_PAGE_SIZE}
        if cursor_to is not None:
            params["to"] = cursor_to

        try:
            resp = requests.get(
                UPBIT_CANDLES_URL, params=params, timeout=REQUEST_TIMEOUT_SECONDS
            )
            resp.raise_for_status()
            candles = resp.json()
        except requests.RequestException as exc:
            raise DataFetchError(
                f"업비트 API 호출 실패 (market={market}, page={page}): {exc}"
            ) from exc

        if not isinstance(candles, list):
            raise DataFetchError(
                f"업비트 API 응답 형식이 올바르지 않습니다 (market={market}): {candles!r}"
            )
        if not candles:
            break  # 더 가져올 데이터가 없음

        candles_all.extend(candles)

        # 업비트는 최신순으로 반환하므로 마지막 원소가 이 페이지에서 가장 오래된 캔들이다.
        oldest_candle = candles[-1]
        try:
            oldest_date = oldest_candle["candle_date_time_kst"][:10]
            oldest_utc = oldest_candle["candle_date_time_utc"]
        except (KeyError, TypeError) as exc:
            raise DataFetchError(
                f"업비트 캔들 데이터 파싱 실패 (market={market}): {oldest_candle!r}"
            ) from exc

        if oldest_date <= listing_date_str:
            break  # 상장일까지 다 모았음

        cursor_to = oldest_utc.replace("T", " ")
        time.sleep(UPBIT_REQUEST_DELAY_SECONDS)
    else:
        logger.warning(
            "업비트 페이지네이션이 최대 반복 횟수(%d)에 도달했습니다 (market=%s). "
            "상장일(%s)까지 전부 모으지 못했을 수 있습니다.",
            MAX_UPBIT_PAGES,
            market,
            listing_date_str,
        )

    return candles_all


def fetch_full_usdt_price_history() -> dict:
    """업비트에서 상장일(USDT_LISTING_DATE)부터 오늘까지 전체 USDT/KRW 종가·
    거래량·거래대금을 {"YYYY-MM-DD": {"usdt_price", "volume", "value"}} 형태로
    반환한다."""
    candles = _fetch_upbit_daily_candles("KRW-USDT", USDT_LISTING_DATE)
    listing_date_str = USDT_LISTING_DATE.isoformat()

    result = {}
    for candle in candles:
        try:
            trade_date = candle["candle_date_time_kst"][:10]
            result[trade_date] = {
                "usdt_price": float(candle["trade_price"]),
                "volume": float(candle["candle_acc_trade_volume"]),
                "value": float(candle["candle_acc_trade_price"]),
            }
        except (KeyError, TypeError, ValueError) as exc:
            raise DataFetchError(f"업비트 USDT 캔들 데이터 파싱 실패: {candle!r}") from exc

    return {d: v for d, v in result.items() if d >= listing_date_str}


def fetch_full_btc_price_history() -> dict:
    """업비트에서 BTC_LISTING_DATE부터 오늘까지 전체 BTC/KRW 종가를
    {"YYYY-MM-DD": price} 형태로 반환한다.

    날짜 키는 candle_date_time_kst가 아니라 candle_date_time_utc를 기준으로
    만든다. 해외 BTC 시세(Bitstamp/Coinbase)와 Frankfurter 환율이 모두 UTC
    00:00 경계로 날짜를 나누므로, 여기서도 UTC 기준을 맞춰야 세 데이터를
    병합할 때 실제로는 9시간 차이 나는 값을 같은 날짜로 잘못 취급하지 않는다.
    """
    candles = _fetch_upbit_daily_candles("KRW-BTC", BTC_LISTING_DATE)
    listing_date_str = BTC_LISTING_DATE.isoformat()

    prices = {}
    for candle in candles:
        try:
            trade_date = candle["candle_date_time_utc"][:10]
            prices[trade_date] = float(candle["trade_price"])
        except (KeyError, TypeError, ValueError) as exc:
            raise DataFetchError(f"업비트 BTC 캔들 데이터 파싱 실패: {candle!r}") from exc

    return {d: p for d, p in prices.items() if d >= listing_date_str}


def fetch_full_fx_rate_history() -> dict:
    """Frankfurter에서 FX_HISTORY_START_DATE부터 오늘까지 전체 원/달러 환율을
    {"YYYY-MM-DD": rate} 형태로 반환한다.

    USDT(2024-06-07~)와 BTC(2017-09-25~) 중 이른 시작일을 쓰므로, 이 결과 하나로
    두 프리미엄 계산을 모두 덮는다. 호출은 기간과 무관하게 항상 1회다.
    """
    end = date.today()
    url = FRANKFURTER_URL_TEMPLATE.format(
        start=FX_HISTORY_START_DATE.isoformat(), end=end.isoformat()
    )

    try:
        resp = requests.get(
            url,
            params={"base": "USD", "symbols": "KRW"},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
        payload = resp.json()
    except requests.RequestException as exc:
        raise DataFetchError(f"Frankfurter API 호출 실패: {exc}") from exc

    rates = payload.get("rates")
    if not isinstance(rates, dict) or not rates:
        raise DataFetchError(f"Frankfurter API 응답 형식이 올바르지 않습니다: {payload!r}")

    fx_rates = {}
    for trade_date, values in rates.items():
        try:
            fx_rates[trade_date] = float(values["KRW"])
        except (KeyError, TypeError, ValueError) as exc:
            raise DataFetchError(
                f"Frankfurter 환율 데이터 파싱 실패: {trade_date} -> {values!r}"
            ) from exc

    return fx_rates


def _fetch_bitstamp_btc_usd_history(start_date: date) -> dict:
    """Bitstamp에서 BTC/USD 일별 종가를 {"YYYY-MM-DD": price} 형태로 반환한다.
    실패하면 _ForeignFetchError를 던진다 (호출자가 Coinbase로 폴백)."""
    prices: dict = {}
    cursor_end = int(datetime.now(timezone.utc).timestamp())
    start_ts = int(
        datetime.combine(start_date, datetime.min.time(), tzinfo=timezone.utc).timestamp()
    )

    for page in range(1, MAX_FOREIGN_BTC_PAGES + 1):
        params = {"step": 86400, "limit": 1000, "end": cursor_end}
        try:
            resp = requests.get(
                BITSTAMP_OHLC_URL, params=params, timeout=REQUEST_TIMEOUT_SECONDS
            )
            resp.raise_for_status()
            payload = resp.json()
            ohlc = payload["data"]["ohlc"]
        except (requests.RequestException, KeyError, TypeError, ValueError) as exc:
            raise _ForeignFetchError(f"Bitstamp API 호출/파싱 실패 (page={page}): {exc}") from exc

        if not ohlc:
            break

        oldest_ts = None
        for item in ohlc:
            try:
                ts = int(item["timestamp"])
                trade_date = datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()
                prices[trade_date] = float(item["close"])
            except (KeyError, TypeError, ValueError) as exc:
                raise _ForeignFetchError(f"Bitstamp 캔들 데이터 파싱 실패: {item!r}") from exc
            if oldest_ts is None or ts < oldest_ts:
                oldest_ts = ts

        if oldest_ts is None or oldest_ts <= start_ts:
            break
        cursor_end = oldest_ts - 1
        time.sleep(FOREIGN_REQUEST_DELAY_SECONDS)
    else:
        logger.warning(
            "Bitstamp 페이지네이션이 최대 반복 횟수(%d)에 도달했습니다.", MAX_FOREIGN_BTC_PAGES
        )

    return {d: p for d, p in prices.items() if d >= start_date.isoformat()}


def _fetch_coinbase_btc_usd_history(start_date: date) -> dict:
    """Coinbase에서 BTC-USD 일별 종가를 {"YYYY-MM-DD": price} 형태로 반환한다
    (Bitstamp 실패 시 폴백). Coinbase는 요청 1회당 최대 300개 캔들 제한이 있어
    day 단위로 잘라서 페이지네이션한다."""
    prices: dict = {}
    end_dt = datetime.now(timezone.utc)
    start_dt_floor = datetime.combine(start_date, datetime.min.time(), tzinfo=timezone.utc)
    window = timedelta(days=299)  # Coinbase 최대 300개 제한에 여유를 둔 폭

    for page in range(1, MAX_FOREIGN_BTC_PAGES + 1):
        window_start = max(end_dt - window, start_dt_floor)
        params = {
            "granularity": 86400,
            "start": window_start.isoformat(),
            "end": end_dt.isoformat(),
        }
        try:
            resp = requests.get(
                COINBASE_CANDLES_URL, params=params, timeout=REQUEST_TIMEOUT_SECONDS
            )
            resp.raise_for_status()
            candles = resp.json()
        except requests.RequestException as exc:
            raise _ForeignFetchError(f"Coinbase API 호출 실패 (page={page}): {exc}") from exc

        if not isinstance(candles, list):
            raise _ForeignFetchError(f"Coinbase 응답 형식이 올바르지 않습니다: {candles!r}")

        for item in candles:
            try:
                ts, _low, _high, _open, close, _volume = item
                trade_date = datetime.fromtimestamp(int(ts), tz=timezone.utc).date().isoformat()
                prices[trade_date] = float(close)
            except (ValueError, TypeError) as exc:
                raise _ForeignFetchError(f"Coinbase 캔들 데이터 파싱 실패: {item!r}") from exc

        if window_start <= start_dt_floor:
            break
        end_dt = window_start - timedelta(seconds=1)
        time.sleep(FOREIGN_REQUEST_DELAY_SECONDS)
    else:
        logger.warning(
            "Coinbase 페이지네이션이 최대 반복 횟수(%d)에 도달했습니다.", MAX_FOREIGN_BTC_PAGES
        )

    return {d: p for d, p in prices.items() if d >= start_date.isoformat()}


def fetch_foreign_btc_usd_history(start_date: date) -> tuple:
    """해외 BTC/USD 시세를 가져온다. Bitstamp를 우선 시도하고, 실패하면
    Coinbase로 자동 전환한다. (가격 dict, 소스 이름) 튜플을 반환한다.
    두 소스가 모두 실패하면 DataFetchError를 던진다."""
    try:
        prices = _fetch_bitstamp_btc_usd_history(start_date)
        if not prices:
            raise _ForeignFetchError("Bitstamp에서 유효한 데이터를 하나도 받지 못했습니다.")
        logger.info("해외 BTC 시세: Bitstamp 사용 (%d일치)", len(prices))
        return prices, "Bitstamp"
    except _ForeignFetchError as exc:
        logger.warning("Bitstamp 실패, Coinbase로 전환합니다: %s", exc)

    try:
        prices = _fetch_coinbase_btc_usd_history(start_date)
        if not prices:
            raise _ForeignFetchError("Coinbase에서도 유효한 데이터를 하나도 받지 못했습니다.")
        logger.info("해외 BTC 시세: Coinbase 사용 (%d일치)", len(prices))
        return prices, "Coinbase"
    except _ForeignFetchError as exc:
        raise DataFetchError(
            f"해외 BTC 시세 조회 실패 (Bitstamp, Coinbase 모두 실패): {exc}"
        ) from exc


def compute_premium_rows(usdt_data: dict, fx_rates: dict) -> list:
    """업비트 USDT 거래일 전체를 기준으로 날짜별 premium_pct를 계산한다 (날짜 오름차순).

    Frankfurter는 주말/공휴일이나 아직 발표되지 않은 최신 날짜의 환율을
    제공하지 않으므로, BTC 프리미엄 계산과 동일하게 _forward_fill_fx_rates로
    직전 거래일 환율을 채워서 쓴다. 이렇게 하면 환율 발표 여부와 무관하게
    usdt_data에 있는 모든 날짜(업비트 거래일 전체)에 대해 premium_pct가
    계산되고, 그 결과 as_of(가장 최근 행의 날짜)도 "가장 최근 환율 발표일"이
    아니라 "가장 최근 업비트 거래일"이 된다.
    """
    target_dates = sorted(usdt_data)
    if not target_dates:
        raise DataFetchError("업비트 USDT 데이터가 비어 있습니다.")

    filled_fx = _forward_fill_fx_rates(fx_rates, target_dates)

    rows = []
    for trade_date in target_dates:
        if trade_date not in filled_fx:
            continue  # 이 날짜 이전에 발표된 환율이 아직 하나도 없음 (아주 초기 날짜)
        usdt_price = usdt_data[trade_date]["usdt_price"]
        fx_rate = filled_fx[trade_date]
        premium_pct = (usdt_price - fx_rate) / fx_rate * 100
        rows.append(
            {
                "date": trade_date,
                "usdt_price": usdt_price,
                "fx_rate": fx_rate,
                "premium_pct": premium_pct,
                "volume": usdt_data[trade_date]["volume"],
                "value": usdt_data[trade_date]["value"],
            }
        )

    if not rows:
        raise DataFetchError("업비트와 환율 데이터를 병합한 결과가 비어 있습니다.")

    return rows


def compute_percentile(values: list, target: float) -> int:
    """target이 values(정렬 후) 중 몇 백분위인지 계산한다 (target 이하 비율 기준, 0~100).

    팀 dashboard.html의 pctOf와 동일한 정의:
    sorted.filter(x => x <= v).length / sorted.length * 100
    """
    sorted_values = sorted(values)
    if not sorted_values:
        return 0
    rank = sum(1 for v in sorted_values if v <= target)
    return round(rank / len(sorted_values) * 100)


def _forward_fill_fx_rates(fx_rates: dict, target_dates: list) -> dict:
    """target_dates 각각에 대해, fx_rates에 해당 날짜가 없으면 직전 거래일의
    환율 값으로 채운 {"YYYY-MM-DD": rate} 딕셔너리를 반환한다 (주말/공휴일
    forward-fill). fx_rates에 그 날짜 이전 값이 아직 하나도 없는 아주 초기
    날짜는 결과에서 제외된다.

    last_known 갱신은 fx_rates와 target_dates의 합집합을 날짜순으로 훑으며
    수행한다 — target_dates만 순회하면, target_dates에는 없지만 fx_rates에는
    있는 날짜의 환율 발표를 건너뛰어 last_known이 실제보다 오래된 값에
    머무를 수 있다. 결과 딕셔너리에는 target_dates에 해당하는 날짜만 담는다.
    """
    target_set = set(target_dates)
    all_dates = sorted(set(fx_rates) | target_set)

    filled = {}
    last_known = None
    for d in all_dates:
        if d in fx_rates:
            last_known = fx_rates[d]
        if d in target_set and last_known is not None:
            filled[d] = last_known
    return filled


def compute_btc_premium_rows(
    btc_krw_prices: dict, foreign_usd_prices: dict, fx_rates: dict, foreign_source: str
) -> list:
    """업비트 BTC, 해외 BTC, 환율(주말/공휴일은 직전 거래일 값으로 forward-fill)을
    날짜 기준으로 병합해 날짜별 btc_premium_pct를 계산한다 (날짜 오름차순).
    세 데이터가 모두 있는 날짜만 포함한다.
    """
    candidate_dates = sorted(set(btc_krw_prices) & set(foreign_usd_prices))
    filled_fx = _forward_fill_fx_rates(fx_rates, candidate_dates)

    rows = []
    for trade_date in candidate_dates:
        if trade_date not in filled_fx:
            continue  # 이 날짜 이전에 발표된 환율이 아직 하나도 없음
        btc_krw_price = btc_krw_prices[trade_date]
        foreign_usd = foreign_usd_prices[trade_date]
        fx_rate = filled_fx[trade_date]
        foreign_krw_equiv = foreign_usd * fx_rate
        btc_premium_pct = (btc_krw_price - foreign_krw_equiv) / foreign_krw_equiv * 100
        rows.append(
            {
                "date": trade_date,
                "btc_krw_price": btc_krw_price,
                "foreignUsd": foreign_usd,
                "foreignSource": foreign_source,
                "btc_premium_pct": btc_premium_pct,
                # fx_rate도 함께 내보낸다. 예전에는 이 값이 USDT 행에만 실렸는데,
                # BTC만 있는 과거 구간에는 USDT 행이 없어 fx_rate가 통째로 빠진다.
                # shared.js의 getBtcPremiumData는 btc_krw_price/foreignUsd/fx_rate가
                # 셋 다 있는 날짜만 통과시키므로, 이게 없으면 과거 구간을 다 받아와도
                # 프런트에서 전부 걸러져 simulator가 예전과 똑같이 2024-06-07부터만
                # 보인다. USDT와 겹치는 날짜에는 같은 forward-fill 결과가 들어가므로
                # 기존 행의 fx_rate 값은 달라지지 않는다.
                "fx_rate": fx_rate,
            }
        )
    return rows


def load_events() -> list:
    if not EVENTS_JSON_PATH.exists():
        logger.warning(
            "이벤트 파일(%s)이 없어 recent_event는 항상 기본값이 됩니다.",
            EVENTS_JSON_PATH,
        )
        return []
    with EVENTS_JSON_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def resolve_recent_event(events: list, today: date) -> str:
    window_start = today - timedelta(days=RECENT_EVENT_WINDOW_DAYS)
    candidates = []
    for event in events:
        try:
            event_date = datetime.strptime(event["date"], "%Y-%m-%d").date()
        except (KeyError, TypeError, ValueError):
            continue
        if window_start <= event_date <= today:
            candidates.append((event_date, event.get("description", "")))

    if not candidates:
        return "특이 이벤트 없음"

    candidates.sort(key=lambda pair: pair[0], reverse=True)
    return candidates[0][1]


def write_json_atomic(path: Path, data) -> None:
    # 임시 파일에 먼저 쓰고 교체(원자적 쓰기)해서, 쓰기 도중 실패해도
    # 기존 파일이 깨진 상태로 남지 않도록 한다.
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".json.tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    tmp_path.replace(path)


def main() -> int:
    try:
        usdt_data = fetch_full_usdt_price_history()
        fx_rates = fetch_full_fx_rate_history()
        rows = compute_premium_rows(usdt_data, fx_rates)

        btc_krw_prices = fetch_full_btc_price_history()
        foreign_usd_prices, foreign_source = fetch_foreign_btc_usd_history(BTC_LISTING_DATE)
        btc_rows = compute_btc_premium_rows(
            btc_krw_prices, foreign_usd_prices, fx_rates, foreign_source
        )
    except DataFetchError as exc:
        logger.error(
            "데이터 갱신 실패, 기존 data/current.json, data/history.json은 그대로 유지합니다: %s",
            exc,
        )
        return 1

    # --- 아래 USDT 프리미엄/percentile/역대 최고·최저 로직은 기존 그대로 ---
    latest = rows[-1]  # 병합된 데이터 중 가장 최근 날짜 = "오늘"
    premium_pct_values = [row["premium_pct"] for row in rows]
    percentile = compute_percentile(premium_pct_values, latest["premium_pct"])

    events = load_events()
    recent_event = resolve_recent_event(events, date.fromisoformat(latest["date"]))

    highest_row = max(rows, key=lambda row: row["premium_pct"])
    lowest_row = min(rows, key=lambda row: row["premium_pct"])

    result = {
        "premium_pct": round(latest["premium_pct"], 2),
        "fx_rate": round(latest["fx_rate"], 2),
        "percentile": percentile,
        "recent_event": recent_event,
        "as_of": latest["date"],
        "historical_max_premium_pct": round(highest_row["premium_pct"], 2),
        "historical_max_premium_date": highest_row["date"],
        "historical_min_premium_pct": round(lowest_row["premium_pct"], 2),
        "historical_min_premium_date": lowest_row["date"],
        "volume": round(latest["volume"], 4),
        "value": round(latest["value"], 2),
    }
    # --- 여기까지 기존 로직 ---

    btc_by_date = {row["date"]: row for row in btc_rows}
    latest_btc = btc_by_date.get(latest["date"])
    if latest_btc is not None:
        result.update(
            {
                "btc_premium_pct": round(latest_btc["btc_premium_pct"], 2),
                "btc_krw_price": round(latest_btc["btc_krw_price"], 2),
                "foreignUsd": round(latest_btc["foreignUsd"], 2),
                "foreignSource": latest_btc["foreignSource"],
            }
        )
    else:
        logger.warning(
            "오늘(%s)자 BTC 프리미엄 데이터를 찾지 못해 current.json에 BTC 필드를 채우지 못했습니다.",
            latest["date"],
        )

    # 매 실행마다 각 시작일부터 오늘까지 전체를 다시 계산하므로, history.json은
    # 기존 내용과 병합하지 않고 이번에 계산한 전체 기간 데이터로 통째로 덮어쓴다.
    # USDT 쪽(2024-06-07~, 평일만)과 BTC 쪽(2017-09-25~, 환율 forward-fill로 주말도
    # 포함)은 시작일도 요일 범위도 다르므로, 날짜를 키로 두 데이터를 합쳐(union)
    # 하나의 history 배열을 만든다.
    #
    # 아래 setdefault는 BTC만 있는 과거 날짜에 {"date": ...}만 있는 행을 만들고
    # BTC 키만 채운다 — 즉 usdt_price/premium_pct/volume/value 키는 아예 생기지
    # 않는다. 이 상태를 유지해야 한다. 자리를 맞추겠다고 "N/A"나 float("nan")
    # 같은 값을 채우면 shared.js의 `!= null` 필터를 통과해버려서, dashboard의
    # Math.min(...series) 축 계산이 NaN이 되고 차트가 통째로 사라진다.
    history_by_date = {}
    for row in rows:
        history_by_date[row["date"]] = {
            "date": row["date"],
            "usdt_price": row["usdt_price"],
            "fx_rate": round(row["fx_rate"], 2),
            "premium_pct": round(row["premium_pct"], 2),
            "volume": round(row["volume"], 4),
            "value": round(row["value"], 2),
        }
    for btc_row in btc_rows:
        entry = history_by_date.setdefault(btc_row["date"], {"date": btc_row["date"]})
        # fx_rate는 USDT 행이 이미 넣어둔 날짜면 같은 값으로 덮어써도 동일하고
        # (같은 fx_rates를 같은 방식으로 forward-fill 했다), USDT 행이 없는 과거
        # 날짜면 여기서 처음 들어간다. dict.update는 기존 키의 순서를 바꾸지 않아
        # 겹치는 날짜의 JSON 키 순서도 그대로 유지된다.
        entry.update(
            {
                "btc_premium_pct": round(btc_row["btc_premium_pct"], 2),
                "btc_krw_price": round(btc_row["btc_krw_price"], 2),
                "foreignUsd": round(btc_row["foreignUsd"], 2),
                "foreignSource": btc_row["foreignSource"],
                "fx_rate": round(btc_row["fx_rate"], 2),
            }
        )

    history = [history_by_date[d] for d in sorted(history_by_date)]

    try:
        write_json_atomic(CURRENT_JSON_PATH, result)
        write_json_atomic(HISTORY_JSON_PATH, history)
    except OSError as exc:
        logger.error("data/current.json 또는 data/history.json 쓰기 실패: %s", exc)
        return 1

    logger.info(
        "data/current.json, data/history.json 갱신 완료 "
        "(USDT %d일치 + BTC %d일치, 최신 날짜=%s, foreignSource=%s): %s",
        len(rows),
        len(btc_rows),
        latest["date"],
        foreign_source,
        result,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
