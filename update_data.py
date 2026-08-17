"""김치프리미엄 데이터 배치 갱신 스크립트 (하루 1회 실행, 예: cron).

- 업비트 USDT/KRW 상장일(2024-06-07)부터 오늘까지 전체 일봉 + Frankfurter
  원/달러 환율을 날짜 기준으로 병합해 날짜별 premium_pct를 계산한다.
- percentile은 "최근 N일"이 아니라 상장일 이후 전체 기간 데이터 중 오늘 값의
  백분위로 계산한다 (팀 dashboard.html의 pctOf 방식과 동일).
- data/history.json에는 상장일부터 오늘까지 전체 기간 데이터를, data/current.json
  에는 오늘(가장 최근 날짜) 값만 저장한다. 매 실행마다 전체 기간을 다시 계산해
  통째로 덮어쓰므로 별도의 누적/병합 로직이 필요 없다.
- 두 API 중 하나라도 실패하면 기존 data/current.json, data/history.json은
  절대 건드리지 않고 에러 로그만 남긴 뒤 0이 아닌 코드로 종료한다.
"""

import json
import logging
import sys
import time
from datetime import date, datetime, timedelta
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

USDT_LISTING_DATE = date(2024, 6, 7)
UPBIT_PAGE_SIZE = 200
MAX_UPBIT_PAGES = 20  # 무한 루프 방지용 상한
UPBIT_REQUEST_DELAY_SECONDS = 0.15  # 페이지 간 대기 (요청 제한 회피)

RECENT_EVENT_WINDOW_DAYS = 7
REQUEST_TIMEOUT_SECONDS = 10


class DataFetchError(Exception):
    """외부 API 호출/파싱 실패, 혹은 병합 가능한 데이터가 없을 때 발생시킨다."""


def fetch_full_usdt_price_history() -> dict:
    """업비트에서 상장일(USDT_LISTING_DATE)부터 오늘까지 전체 USDT/KRW 종가를
    {"YYYY-MM-DD": price} 형태로 반환한다.

    한 번에 최대 UPBIT_PAGE_SIZE개(200개)만 오므로, to= 커서를 이전 페이지의
    가장 오래된 캔들 시각으로 옮겨가며 반복 호출한다. 상장일에 도달하거나
    MAX_UPBIT_PAGES 횟수에 도달하면 멈춘다.
    """
    prices: dict = {}
    cursor_to = None
    listing_date_str = USDT_LISTING_DATE.isoformat()

    for page in range(1, MAX_UPBIT_PAGES + 1):
        params = {"market": "KRW-USDT", "count": UPBIT_PAGE_SIZE}
        if cursor_to is not None:
            params["to"] = cursor_to

        try:
            resp = requests.get(
                UPBIT_CANDLES_URL, params=params, timeout=REQUEST_TIMEOUT_SECONDS
            )
            resp.raise_for_status()
            candles = resp.json()
        except requests.RequestException as exc:
            raise DataFetchError(f"업비트 API 호출 실패 (page={page}): {exc}") from exc

        if not isinstance(candles, list):
            raise DataFetchError(f"업비트 API 응답 형식이 올바르지 않습니다: {candles!r}")
        if not candles:
            break  # 더 가져올 데이터가 없음

        for candle in candles:
            try:
                trade_date = candle["candle_date_time_kst"][:10]
                prices[trade_date] = float(candle["trade_price"])
            except (KeyError, TypeError, ValueError) as exc:
                raise DataFetchError(f"업비트 캔들 데이터 파싱 실패: {candle!r}") from exc

        # 업비트는 최신순으로 반환하므로 마지막 원소가 이 페이지에서 가장 오래된 캔들이다.
        oldest_candle = candles[-1]
        oldest_date = oldest_candle["candle_date_time_kst"][:10]

        if oldest_date <= listing_date_str:
            break  # 상장일까지 다 모았음

        cursor_to = oldest_candle["candle_date_time_utc"].replace("T", " ")
        time.sleep(UPBIT_REQUEST_DELAY_SECONDS)
    else:
        logger.warning(
            "업비트 페이지네이션이 최대 반복 횟수(%d)에 도달했습니다. "
            "상장일(%s)까지 전부 모으지 못했을 수 있습니다.",
            MAX_UPBIT_PAGES,
            listing_date_str,
        )

    return {d: p for d, p in prices.items() if d >= listing_date_str}


def fetch_full_fx_rate_history() -> dict:
    """Frankfurter에서 상장일부터 오늘까지 전체 원/달러 환율을
    {"YYYY-MM-DD": rate} 형태로 반환한다."""
    end = date.today()
    url = FRANKFURTER_URL_TEMPLATE.format(
        start=USDT_LISTING_DATE.isoformat(), end=end.isoformat()
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


def compute_premium_rows(usdt_prices: dict, fx_rates: dict) -> list:
    """두 데이터를 날짜 기준 교집합으로 병합해 날짜별 premium_pct를 계산한다 (날짜 오름차순).

    Frankfurter는 주말/공휴일 환율을 제공하지 않으므로, 두 데이터셋에
    공통으로 존재하는 날짜만 사용한다.
    """
    common_dates = sorted(set(usdt_prices) & set(fx_rates))
    if not common_dates:
        raise DataFetchError("업비트와 환율 데이터의 날짜가 하나도 겹치지 않습니다.")

    rows = []
    for trade_date in common_dates:
        usdt_price = usdt_prices[trade_date]
        fx_rate = fx_rates[trade_date]
        premium_pct = (usdt_price - fx_rate) / fx_rate * 100
        rows.append(
            {
                "date": trade_date,
                "usdt_price": usdt_price,
                "fx_rate": fx_rate,
                "premium_pct": premium_pct,
            }
        )
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
        usdt_prices = fetch_full_usdt_price_history()
        fx_rates = fetch_full_fx_rate_history()
        rows = compute_premium_rows(usdt_prices, fx_rates)
    except DataFetchError as exc:
        logger.error(
            "데이터 갱신 실패, 기존 data/current.json, data/history.json은 그대로 유지합니다: %s",
            exc,
        )
        return 1

    latest = rows[-1]  # 병합된 데이터 중 가장 최근 날짜 = "오늘"
    premium_pct_values = [row["premium_pct"] for row in rows]
    percentile = compute_percentile(premium_pct_values, latest["premium_pct"])

    events = load_events()
    recent_event = resolve_recent_event(events, date.fromisoformat(latest["date"]))

    result = {
        "premium_pct": round(latest["premium_pct"], 2),
        "fx_rate": round(latest["fx_rate"], 2),
        "percentile": percentile,
        "recent_event": recent_event,
        "as_of": latest["date"],
    }

    # 매 실행마다 상장일부터 오늘까지 전체를 다시 계산하므로, history.json은
    # 기존 내용과 병합하지 않고 이번에 계산한 전체 기간 데이터로 통째로 덮어쓴다.
    history = [
        {
            "date": row["date"],
            "usdt_price": row["usdt_price"],
            "fx_rate": round(row["fx_rate"], 2),
            "premium_pct": round(row["premium_pct"], 2),
        }
        for row in rows
    ]

    try:
        write_json_atomic(CURRENT_JSON_PATH, result)
        write_json_atomic(HISTORY_JSON_PATH, history)
    except OSError as exc:
        logger.error("data/current.json 또는 data/history.json 쓰기 실패: %s", exc)
        return 1

    logger.info(
        "data/current.json, data/history.json 갱신 완료 "
        "(상장일 이후 전체 %d일치 데이터, 최신 날짜=%s): %s",
        len(rows),
        latest["date"],
        result,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
