"""김치프리미엄 데이터 설명 챗봇 백엔드 (FastAPI)

- POST /api/chat 하나만 제공한다.
- 세션당 최대 10회, 서버 전체 하루 100회로 호출을 이중 제한한다 (메모리 기반, DB 없음).
- LLM 호출은 매 요청 1회(Tool Use 없이 data/current.json을 시스템 프롬프트에 직접 삽입)로 고정한다.
"""

import asyncio
import json
import os
import re
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

from google import genai
from google.genai import types as genai_types
from google.genai.errors import APIError
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError

load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
MODEL_NAME = "gemini-flash-latest"

BASE_DIR = Path(__file__).resolve().parent
DATA_PATH = BASE_DIR / "data" / "current.json"

SESSION_CHAT_LIMIT = 10
DAILY_CHAT_LIMIT = 100
# X-Session-ID는 클라이언트가 자유롭게 정하는 값이라 헤더를 바꾸면 세션당
# 제한을 우회할 수 있다. 이를 막기 위한 독립적인 IP 기반 백스톱.
IP_CHAT_LIMIT = 30
GEMINI_TIMEOUT_SECONDS = 15
# 주말/공휴일에 update-data 워크플로우가 안 돌 수 있어 여유를 둔다.
MAX_DATA_AGE_DAYS = 3
MAX_REPLY_LENGTH = 220

BANNED_WORDS = [
    "매수",
    "매도",
    "사세요",
    "파세요",
    "매수하세요",
    "매도하세요",
    "투자하세요",
    "투자를 추천",
    "지금이 기회",
    "오를 것",
    "오를것",
    "오를 겁니다",
    "내릴 것",
    "내릴것",
    "떨어질 것",
    "수익률이 오를",
    "수익을 낼 수",
    "buy",
    "sell",
    "invest now",
]
# 금지 문구가 등장해도, 근처에 "그건 모른다/못 정해준다"는 취지의 거절·완곡 표현이
# 있으면 실제 투자 지시가 아니라 완곡한 거절일 가능성이 높으므로 예외로 둔다.
NEGATION_CUES = [
    "예측할 수 없",
    "예측하기 어려",
    "알 수 없",
    "판단할 수 없",
    "판단해 드릴 수 없",
    "정해드릴 수 없",
    "정해 드릴 수 없",
    "말씀드리기 어려",
    "도와드리기 어려",
    "권해드릴 수 없",
    "제가 결정해 드릴 수 없",
    "판단은 어려",
]
BANNED_WORD_CONTEXT_WINDOW = 20
DISCLAIMER = "(본 내용은 투자 조언이 아니며 데이터 해석 참고용입니다.)"
SIGNOFF = "개굴!"
REPLY_SUFFIX = f"{DISCLAIMER}\n{SIGNOFF}"
SAFE_FALLBACK_REPLY = (
    "죄송해요, 투자 행동을 유도하는 표현이 포함되어 있어서 답변을 대신 알려드릴게요. "
    "데이터 수치의 의미에 대해 다시 질문해 주세요! " + REPLY_SUFFIX
)

if not GEMINI_API_KEY:
    # 서버는 계속 기동되지만(문서 확인 등은 가능), /api/chat 호출 시 명확한 에러를 반환한다.
    print(
        "\n⚠️  GEMINI_API_KEY가 설정되어 있지 않습니다.\n"
        "   .env 파일을 만들고 GEMINI_API_KEY=AI... 형식으로 키를 추가한 뒤\n"
        "   서버를 다시 시작하세요. (.env.example 참고)\n"
        "   키가 없어도 서버는 기동되지만 /api/chat 호출은 500 에러를 반환합니다.\n"
    )
    genai_client = None
else:
    genai_client = genai.Client(api_key=GEMINI_API_KEY)

app = FastAPI(title="Kimchi Premium Chatbot API")

# 배포된 프론트 도메인만 허용. 로컬 개발용 주소는 기본값으로 유지하고,
# 필요 시 ALLOWED_ORIGINS 환경변수(콤마 구분)로 덮어쓴다.
DEFAULT_ALLOWED_ORIGINS = "https://kimplog.vercel.app,http://localhost:5500,http://127.0.0.1:5500"
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", DEFAULT_ALLOWED_ORIGINS).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["POST"],
    allow_headers=["Content-Type", "X-Session-ID"],
)

# 비용 제어용 인메모리 카운터. 날짜가 바뀌면 전부 리셋된다.
# ⚠️ 워커(프로세스)마다 별도 메모리를 쓰므로, 워커가 2개 이상이면 카운터가
# 워커별로 따로 세져서 일일/세션 제한이 사실상 무력화된다.
# 배포 시 반드시 단일 워커로 실행할 것 (예: `uvicorn main:app --workers 1`,
# 또는 --workers 옵션을 아예 생략 - uvicorn 기본값이 1).
# 제한을 워커 여러 개에서도 정확히 지켜야 한다면 이 인메모리 dict를
# Redis 등 외부 저장소로 옮겨야 한다.
_usage_state = {
    "date": date.today(),
    "daily_count": 0,
    "session_counts": defaultdict(int),
    "ip_counts": defaultdict(int),
}


def _reset_counters_if_new_day() -> None:
    today = date.today()
    if _usage_state["date"] != today:
        _usage_state["date"] = today
        _usage_state["daily_count"] = 0
        _usage_state["session_counts"] = defaultdict(int)
        _usage_state["ip_counts"] = defaultdict(int)


class MarketData(BaseModel):
    premium_pct: float
    fx_rate: float
    percentile: int
    recent_event: str
    as_of: date


def _load_market_data() -> MarketData:
    if not DATA_PATH.exists():
        raise HTTPException(
            status_code=500,
            detail="시장 데이터 파일(data/current.json)을 찾을 수 없습니다.",
        )
    try:
        with DATA_PATH.open("r", encoding="utf-8") as f:
            raw = json.load(f)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=500,
            detail="시장 데이터 파일(data/current.json)의 형식이 올바르지 않습니다.",
        ) from exc

    try:
        data = MarketData.model_validate(raw)
    except ValidationError as exc:
        raise HTTPException(
            status_code=500,
            detail="시장 데이터 파일(data/current.json)의 필드가 올바르지 않습니다.",
        ) from exc

    if date.today() - data.as_of > timedelta(days=MAX_DATA_AGE_DAYS):
        raise HTTPException(
            status_code=503,
            detail="시장 데이터가 오래되어(최신화 실패) 챗봇을 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.",
        )

    return data


def _build_system_prompt(data: MarketData) -> str:
    # Tool Use(함수 호출) 대신, 매 요청마다 서버가 먼저 data/current.json을 읽어
    # 그 내용을 시스템 프롬프트에 텍스트로 끼워 넣는다.
    # 이렇게 하면 "데이터 조회 tool_use -> tool_result -> 최종 응답"으로 이어지는
    # API 왕복이 1회로 줄어들어 속도가 빨라지고 비용도 절감된다.
    return f"""당신은 '김치프리미엄' 데이터를 설명해주는 금융 데이터 해설 챗봇입니다.

다음은 현재 시점의 실제 데이터입니다. 답변은 반드시 이 수치에 근거해야 합니다:
- 기준일(as_of): {data.as_of.isoformat()}
- 프리미엄(premium_pct): {data.premium_pct}%
- 원/달러 환율(fx_rate): {data.fx_rate}
- USDT 상장(2024-06-07) 이후 전체 기간 대비 백분위(percentile): {data.percentile}
- 최근 이벤트(recent_event): {data.recent_event}

[답변 원칙 - 반드시 지킬 것]
1. 위 데이터의 실제 수치를 근거로만 답변하세요. 데이터에 없는 내용은 추측해서 말하지 마세요.
2. "매수", "매도", "지금 사세요", "지금 파세요"와 같은 투자 행동 지시나 수익률 예측은 절대 하지 마세요.
3. 데이터가 무엇을 의미하는지는 설명하되, 최종 판단은 항상 사용자 본인이 하도록 유도하세요. AI가 대신 판단해주지 마세요.
4. "지금 살까요?", "팔까요?", "얼마에 사야 해요?", "언제가 저점이에요?"처럼 매수/매도/매매
   타이밍/목표가를 직접 묻는 질문에는 "그건 답해줄 수 없어요"처럼 딱 잘라 거절하지 말고,
   "그건 제가 판단해 드릴 수 없지만, 지금 수치가 이런 의미예요~"처럼 완곡한 거절 표현으로
   시작한 뒤 자연스럽게 화제를 데이터 해석으로 돌려서 답하세요. 왜 답할 수 없는지 딱딱하게
   설명하지 말고, 친절하게 다른 유용한 정보(현재 수치, 백분위, 최근 이벤트 등)로 안내하는
   방식으로 에둘러 답하세요.
5. "~해요", "~예요"처럼 친절하고 다정한 존댓말(해요체)을 사용하고, 딱딱한 설명 대신 사용자가
   이해하기 쉽게 자세히 풀어서 설명하세요. 답변 전체 길이(아래 6번 문구 포함)는 {MAX_REPLY_LENGTH}자
   이내로 작성하세요.
6. 답변의 맨 마지막 두 줄에는 반드시 아래 내용을 그대로, 이 순서대로 추가하세요:
"{DISCLAIMER}"
"{SIGNOFF}"
"""


def _violates_safety_policy(reply: str) -> bool:
    lowered = reply.lower()
    for word in BANNED_WORDS:
        needle = word.lower()
        start = 0
        while True:
            idx = lowered.find(needle, start)
            if idx == -1:
                break
            window = reply[
                max(0, idx - BANNED_WORD_CONTEXT_WINDOW) : idx
                + len(word)
                + BANNED_WORD_CONTEXT_WINDOW
            ]
            # 근처에 거절/완곡 표현이 없을 때만 실제 위반으로 판단한다.
            if not any(cue in window for cue in NEGATION_CUES):
                return True
            start = idx + len(needle)
    return False


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=500)


class ChatResponse(BaseModel):
    reply: str
    generated_at: str


@app.post("/api/chat", response_model=ChatResponse)
async def chat(
    body: ChatRequest, request: Request, x_session_id: str = Header(...)
) -> ChatResponse:
    if not GEMINI_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="GEMINI_API_KEY가 설정되지 않았습니다. .env 파일에 키를 추가한 뒤 서버를 다시 시작하세요.",
        )

    _reset_counters_if_new_day()

    client_ip = request.client.host if request.client else "unknown"

    if _usage_state["daily_count"] >= DAILY_CHAT_LIMIT:
        raise HTTPException(
            status_code=429,
            detail="오늘의 대화 한도에 도달했습니다. 내일 다시 이용해 주세요.",
        )

    # X-Session-ID는 클라이언트가 임의로 바꿀 수 있으므로, 헤더 회전으로
    # session_counts 제한을 우회하지 못하도록 IP 기준 제한을 별도로 건다.
    if _usage_state["ip_counts"][client_ip] >= IP_CHAT_LIMIT:
        raise HTTPException(
            status_code=429,
            detail="현재 위치에서 사용 가능한 채팅 횟수를 모두 사용했습니다.",
        )

    if _usage_state["session_counts"][x_session_id] >= SESSION_CHAT_LIMIT:
        raise HTTPException(
            status_code=429,
            detail="이 세션에서 사용 가능한 채팅 횟수를 모두 사용했습니다.",
        )

    # 제한을 통과한 시점에 슬롯을 즉시 예약한다 (이 지점까지는 await가 없어 동시 요청에도 안전).
    _usage_state["daily_count"] += 1
    _usage_state["ip_counts"][client_ip] += 1
    _usage_state["session_counts"][x_session_id] += 1

    market_data = _load_market_data()
    system_prompt = _build_system_prompt(market_data)

    try:
        # google-genai는 aio 네임스페이스로 진짜 비동기 호출을 제공하므로
        # 별도 스레드로 감쌀 필요 없이 이벤트 루프를 막지 않는다.
        # 응답이 지연되면 asyncio.wait_for로 타임아웃을 건다.
        response = await asyncio.wait_for(
            genai_client.aio.models.generate_content(
                model=MODEL_NAME,
                contents=body.message,
                config=genai_types.GenerateContentConfig(
                    system_instruction=system_prompt,
                ),
            ),
            timeout=GEMINI_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError as exc:
        raise HTTPException(
            status_code=504,
            detail="Gemini API 응답이 지연되어 요청을 중단했습니다. 다시 시도해 주세요.",
        ) from exc
    except APIError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Gemini API 호출에 실패했습니다: {exc.message}",
        ) from exc

    # response.text는 candidate가 없거나 안전 필터에 걸려 차단된 경우 ValueError를
    # 던진다. 바로 읽지 않고 candidate/차단 여부를 먼저 확인해 안전한 대체 응답으로
    # 처리한다.
    blocked = bool(
        getattr(response, "prompt_feedback", None)
        and getattr(response.prompt_feedback, "block_reason", None)
    )
    has_valid_candidate = any(
        getattr(candidate, "content", None) and candidate.content.parts
        for candidate in getattr(response, "candidates", None) or []
    )

    if blocked or not has_valid_candidate:
        reply_text = SAFE_FALLBACK_REPLY
    else:
        reply_text = response.text

    # 2차 안전장치: 금지 단어가 섞여 나오거나, 길이/디스클레이머 형식을 지키지
    # 않으면 안전한 대체 메시지로 교체한다.
    if (
        _violates_safety_policy(reply_text)
        or len(reply_text) > MAX_REPLY_LENGTH
        or not reply_text.endswith(REPLY_SUFFIX)
    ):
        reply_text = SAFE_FALLBACK_REPLY

    return ChatResponse(reply=reply_text, generated_at=date.today().isoformat())
