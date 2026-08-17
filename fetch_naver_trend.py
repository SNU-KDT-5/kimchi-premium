"""네이버 검색어 트렌드를 받아 naver_trend.json 으로 저장한다.

대시보드는 정적 사이트라 브라우저에서 API를 직접 부를 수 없다.
(키가 노출되고 CORS 로도 막힌다)
검색어 트렌드는 어차피 일 단위 데이터라 실시간이 의미 없으므로,
하루 한 번 이 스크립트를 돌려 결과 파일을 레포에 커밋하는 방식을 쓴다.

── 인증 ───────────────────────────────────────────────────
검색어 트렌드 API 는 NAVER API HUB(네이버 클라우드 플랫폼)로 이관됐다.
인증 헤더는 '주소'를 보고 고르므로, 환경변수에 두 방식의 키가 함께 남아 있어도
엉뚱한 헤더를 보내지 않는다.

  기본 — NAVER API HUB
     export NCP_API_KEY_ID=...
     export NCP_API_KEY=...
     (콘솔 → NAVER API HUB → Application → API 관리 → 인증 정보)

  구 developers.naver.com 주소를 쓸 때만
     export NAVER_TREND_URL=https://openapi.naver.com/v1/datalab/search
     export NAVER_CLIENT_ID=...
     export NAVER_CLIENT_SECRET=...

── 사용법 ────────────────────────────────────────────────
     python3 fetch_naver_trend.py

키는 절대 코드에 적지 말 것. .env 는 .gitignore 에 넣을 것.
"""

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date

# NAVER API HUB 의 검색어 트렌드 엔드포인트.
# (구 developers.naver.com 주소인 openapi.naver.com/v1/datalab/search 는 API HUB 키로는 통하지 않는다)
DEFAULT_URL = "https://naverapihub.apigw.ntruss.com/search-trend/v1/search"
OUT_PATH = "naver_trend.json"

# 업비트 KRW-USDT 상장일. 대시보드의 다른 지표와 기간을 맞춘다.
#
# ★ 이 값을 바꾸지 말 것 ★
# 검색어 트렌드가 주는 ratio 는 "요청한 기간 안에서 가장 높았던 날 = 100" 인
# 상대값이다. 시작일을 바꾸면 과거 날짜의 값까지 전부 다시 계산되어,
# 어제 만든 파일과 오늘 만든 파일을 이어 붙일 수 없게 된다.
START_DATE = "2024-06-07"

# 그룹당 키워드는 최대 20개, 그룹은 최대 5개.
# 주의: 한 요청에 넣은 그룹들은 서로 같은 기준으로 정규화된다.
# 검색량이 압도적인 '비트코인' 을 같이 넣으면 테더가 2~3 으로 깔려서
# 변화가 안 보인다. 그래서 규모가 비슷한 것끼리만 묶는다.
KEYWORD_GROUPS = [
    {"groupName": "테더", "keywords": ["테더", "USDT", "테더코인"]},
    {"groupName": "김치프리미엄", "keywords": ["김치프리미엄", "김프", "김프율"]},
]


def build_auth_headers(url):
    """엔드포인트에 맞는 인증 헤더를 고른다.

    두 방식의 키가 환경변수에 함께 남아 있어도, 주소에 맞는 쪽만 쓴다.
    (예전에는 환경변수만 보고 골라서, API HUB 주소에 구 방식 헤더를 보내
     'Authentication information are missing' 401 이 나는 일이 있었다)
    """
    if "ntruss.com" in url:
        key_id = os.environ.get("NCP_API_KEY_ID")
        key = os.environ.get("NCP_API_KEY")
        if key_id and key:
            return {
                "X-NCP-APIGW-API-KEY-ID": key_id,
                "X-NCP-APIGW-API-KEY": key,
            }, "NAVER API HUB 방식"
        sys.exit(
            "NAVER API HUB 주소인데 인증 정보가 없습니다.\n\n"
            "  export NCP_API_KEY_ID=...\n"
            "  export NCP_API_KEY=...\n\n"
            "(콘솔 → NAVER API HUB → Application → API 관리 → 인증 정보)"
        )

    client_id = os.environ.get("NAVER_CLIENT_ID")
    client_secret = os.environ.get("NAVER_CLIENT_SECRET")
    if client_id and client_secret:
        return {
            "X-Naver-Client-Id": client_id,
            "X-Naver-Client-Secret": client_secret,
        }, "developers.naver.com 방식"

    sys.exit(
        f"이 주소({url})에 맞는 인증 정보가 없습니다.\n\n"
        "  export NAVER_CLIENT_ID=...\n"
        "  export NAVER_CLIENT_SECRET=...\n\n"
        "NAVER API HUB 키를 쓰신다면 NAVER_TREND_URL 을 지우고 기본 주소를 사용하세요."
    )


def fetch_trend(url, headers):
    body = json.dumps(
        {
            "startDate": START_DATE,
            "endDate": date.today().isoformat(),
            "timeUnit": "date",
            "keywordGroups": KEYWORD_GROUPS,
        },
        ensure_ascii=False,
    ).encode("utf-8")

    headers = dict(headers)
    headers["Content-Type"] = "application/json"

    request = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read())


def main():
    url = os.environ.get("NAVER_TREND_URL", DEFAULT_URL)
    headers, mode = build_auth_headers(url)

    print(f"인증: {mode}")
    print(f"엔드포인트: {url}")
    print(f"기간: {START_DATE} ~ {date.today().isoformat()}\n")

    try:
        result = fetch_trend(url, headers)
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace")
        hint = ""
        if err.code in (401, 403):
            hint = (
                "\n\n힌트: 인증이 거부됐습니다. 콘솔의 API 가이드에서 헤더 이름을 확인하고\n"
                "      다른 인증 방식(A/B)으로 바꿔서 다시 시도해보세요."
            )
        elif err.code == 404:
            hint = (
                "\n\n힌트: 주소를 찾지 못했습니다. API 가이드의 엔드포인트를 확인하고\n"
                "      export NAVER_TREND_URL=... 로 지정해보세요."
            )
        sys.exit(f"요청 실패 (HTTP {err.code})\n{detail}{hint}")
    except urllib.error.URLError as err:
        sys.exit(f"네트워크 오류: {err.reason}")

    # 대시보드가 읽는 형식: { "테더": { "2024-06-07": 12.3, ... }, ... }
    series = {
        item["title"]: {row["period"]: row["ratio"] for row in item["data"]}
        for item in result.get("results", [])
    }

    if not series:
        sys.exit(f"응답에 결과가 없습니다. 원본 응답:\n{json.dumps(result, ensure_ascii=False)[:500]}")

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(series, f, ensure_ascii=False, separators=(",", ":"))

    for name, points in series.items():
        days = sorted(points)
        print(f"{name}: {len(days)}일 ({days[0]} ~ {days[-1]})")
    print(f"\n저장 완료 → {OUT_PATH}")


if __name__ == "__main__":
    main()