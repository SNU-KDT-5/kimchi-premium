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
from google.genai.errors import APIError, ServerError
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError

load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
MODEL_NAME = "gemini-3.5-flash-lite"

BASE_DIR = Path(__file__).resolve().parent
DATA_PATH = BASE_DIR.parent / "data" / "current.json"

SESSION_CHAT_LIMIT = 10
DAILY_CHAT_LIMIT = 100
# X-Session-ID는 클라이언트가 자유롭게 정하는 값이라 헤더를 바꾸면 세션당
# 제한을 우회할 수 있다. 이를 막기 위한 독립적인 IP 기반 백스톱.
IP_CHAT_LIMIT = 30
GEMINI_TIMEOUT_SECONDS = 25
# Gemini가 일시적으로 과부하(503)일 때 재시도할 횟수와 대기 시간(초).
GEMINI_RETRY_ATTEMPTS = 3
GEMINI_RETRY_DELAY_SECONDS = 2
# 주말/공휴일에 update-data 워크플로우가 안 돌 수 있어 여유를 둔다.
MAX_DATA_AGE_DAYS = 3
MAX_REPLY_LENGTH = 280
# 응답 폭주(끝없이 길게 생성)를 막는 1차 방어선. MAX_REPLY_LENGTH(글자수) 검증은
# 그대로 유지하고, 이건 토큰 단위의 하드 캡이다.
MAX_OUTPUT_TOKENS = 500

SIGNOFF = "개굴!"
REPLY_SUFFIX = SIGNOFF

# 모델이 스스로 매기는 is_investment_directive는 같은 응답 안에서 모델이
# 직접 써내는 값이라, response_schema로는 "불리언 타입인지"만 검증될 뿐 그
# 판단이 실제로 맞는지는 검증되지 않는다. 프롬프트 인젝션 등으로 모델이
# 매매 지시를 쓰면서 false라고 잘못(혹은 속아서) 표시할 경우를 대비해,
# 아주 명확한 명령형 어미만 잡는 좁은 서버 사이드 백스톱을 둔다. 예전에
# 지웠던 "매수"/"매도" 단독 명사나 "오를 것"/"내릴 것" 같은 넓은 패턴은
# 설명 질문까지 오탐을 냈으므로 다시 넣지 않는다 — 모델 판단은 여전히
# 주 신호이고, 이건 명백한 경우만 잡는 보조 안전망이다.
DIRECTIVE_BACKSTOP_PATTERNS = [
    re.compile(pattern)
    for pattern in [
        r"사세요",
        r"파세요",
        r"매수(하세요|하십시오)",
        r"매도(하세요|하십시오)",
        r"목표가는?\s*[\d,]+\s*원",
    ]
]


def _contains_directive_backstop(reply: str) -> bool:
    return any(p.search(reply) for p in DIRECTIVE_BACKSTOP_PATTERNS)

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
    historical_max_premium_pct: float
    historical_max_premium_date: date
    historical_min_premium_pct: float
    historical_min_premium_date: date


class ChatModelOutput(BaseModel):
    reply: str
    # 규칙 기반(금지어 목록) 대신, 모델 스스로 자기 답변이 구체적인 매수/매도
    # 행동 지시·목표가·수익 예측을 담고 있는지 판단하게 한다. 문맥과 의도를
    # 고려해야 하는 판단이라 정규식/키워드 매칭보다 훨씬 정확하다.
    is_investment_directive: bool


# 가드레일 설정
def _build_safe_fallback_reply(data: MarketData) -> str:
    # 정적인 문구 대신, 그 순간의 실제 데이터를 넣어서 그 자체로 답이 되게 한다.
    return (
        "매매 타이밍이나 목표가는 제가 정해드릴 수 없어요. 대신 현재 수치를 알려드릴게요: "
        f"프리미엄 {data.premium_pct}%, 원/달러 환율 {data.fx_rate}원, "
        f"USDT 상장 이후 백분위 {data.percentile}%예요. "
        "이 수치를 참고해서 직접 판단해 보세요! " + REPLY_SUFFIX
    )


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


def _format_date_kr(d: date) -> str:
    # 모델이 isoformat()을 직접 한글로 풀어 쓰다가 어색하게 뭉개는 걸 막기
    # 위해, 서버에서 미리 "YYYY년 M월 D일" 형태로 만들어 프롬프트에 넣는다.
    return f"{d.year}년 {d.month}월 {d.day}일"


def _build_system_prompt(data: MarketData) -> str:
    # Tool Use(함수 호출) 대신, 매 요청마다 서버가 먼저 data/current.json을 읽어
    # 그 내용을 시스템 프롬프트에 텍스트로 끼워 넣는다.
    # 이렇게 하면 "데이터 조회 tool_use -> tool_result -> 최종 응답"으로 이어지는
    # API 왕복이 1회로 줄어들어 속도가 빨라지고 비용도 절감된다.
    return f"""당신은 '김치프리미엄' 데이터를 설명해주는 금융 데이터 해설 챗봇입니다.

다음은 현재 시점의 실제 데이터입니다. 답변은 반드시 이 수치에 근거해야 합니다:
- 기준일(as_of): {_format_date_kr(data.as_of)}
- 프리미엄(premium_pct): {data.premium_pct}%
- 원/달러 환율(fx_rate): {data.fx_rate}
- USDT 상장(2024-06-07) 이후 전체 기간 대비 백분위(percentile): {data.percentile}
- 최근 이벤트(recent_event): {data.recent_event}
- 상장 이후 역대 최고 프리미엄: {data.historical_max_premium_pct}% ({_format_date_kr(data.historical_max_premium_date)})
- 상장 이후 역대 최저 프리미엄: {data.historical_min_premium_pct}% ({_format_date_kr(data.historical_min_premium_date)})

[답변 원칙 - 반드시 지킬 것]
1. 위 데이터의 실제 수치를 근거로만 답변하세요. 데이터에 없는 내용은 추측해서 말하지 마세요.
   날짜를 언급할 때는 위에 주어진 "OOOO년 O월 O일" 형식을 그대로 사용하고, 다른 형식으로
   직접 변환하거나 줄여 쓰지 마세요.
2. 데이터가 무엇을 의미하는지는 설명하되, 최종 판단은 항상 사용자 본인이 하도록 유도하세요. AI가 대신 판단해주지 마세요.
3. "지금 살까요?", "팔까요?", "얼마에 사야 해요?", "언제가 저점이에요?"처럼 매수/매도/매매
   타이밍/목표가를 직접 묻는 질문에는 "그건 답해줄 수 없어요"처럼 딱 잘라 거절하지 말고,
   "그건 제가 판단해 드릴 수 없지만, 지금 수치가 이런 의미예요~"처럼 완곡한 거절 표현으로
   시작한 뒤 자연스럽게 화제를 데이터 해석으로 돌려서 답하세요. 왜 답할 수 없는지 딱딱하게
   설명하지 말고, 친절하게 다른 유용한 정보(현재 수치, 백분위, 최근 이벤트 등)로 안내하는
   방식으로 에둘러 답하세요.
4. "~해요", "~예요"처럼 친절하고 다정한 존댓말(해요체)을 사용하고, 딱딱한 설명 대신 사용자가
   이해하기 쉽게 자세히 풀어서 설명하세요. 답변 전체 길이(아래 5번 문구 포함)는 {MAX_REPLY_LENGTH}자
   이내로 작성하세요.
5. 답변의 맨 마지막에는 반드시 아래 내용을 그대로 추가하세요:
"{SIGNOFF}"

[출력 형식 - 반드시 지정된 스키마의 JSON으로만 응답]
- reply: 위 원칙을 지킨 실제 답변 텍스트
- is_investment_directive: 방금 작성한 reply 자체를 스스로 다시 검토해서 판단하세요.
  다음 중 하나라도 해당하면 true: 구체적인 매수/매도 행동을 지시함, 특정 가격·시점을
  매매 타이밍으로 콕 집어 추천함, 앞으로 오르내릴지 단정적으로 예측함.
  반대로 데이터 정의를 설명하거나, 과거 통계/역사적 경향을 있는 그대로 서술하거나,
  매매 타이밍 질문에 위 3번 원칙대로 완곡히 거절하며 화제를 데이터 해석으로 돌린
  경우는 false입니다. 단순히 "매수"/"매도"라는 단어가 등장했다는 이유만으로 true로
  판단하지 마세요 — 실제로 행동을 지시하거나 예측을 확정하는지가 기준입니다.
"""




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

    # google-genai는 aio 네임스페이스로 진짜 비동기 호출을 제공하므로
    # 별도 스레드로 감쌀 필요 없이 이벤트 루프를 막지 않는다.
    # 응답이 지연되면 asyncio.wait_for로 타임아웃을 건다.
    last_error: Exception | None = None
    response = None
    for attempt in range(GEMINI_RETRY_ATTEMPTS):
        try:
            response = await asyncio.wait_for(
                genai_client.aio.models.generate_content(
                    model=MODEL_NAME,
                    contents=body.message,
                    config=genai_types.GenerateContentConfig(
                        system_instruction=system_prompt,
                        max_output_tokens=MAX_OUTPUT_TOKENS,
                        response_mime_type="application/json",
                        response_schema=ChatModelOutput,
                    ),
                ),
                timeout=GEMINI_TIMEOUT_SECONDS,
            )
            break
        except asyncio.TimeoutError as exc:
            raise HTTPException(
                status_code=504,
                detail="Gemini API 응답이 지연되어 요청을 중단했습니다. 다시 시도해 주세요.",
            ) from exc
        except ServerError as exc:
            # 503 등 Gemini 쪽 일시적 과부하는 잠깐 대기 후 재시도한다.
            last_error = exc
            if attempt < GEMINI_RETRY_ATTEMPTS - 1:
                await asyncio.sleep(GEMINI_RETRY_DELAY_SECONDS)
        except APIError as exc:
            raise HTTPException(
                status_code=502,
                detail=f"Gemini API 호출에 실패했습니다: {exc.message}",
            ) from exc

    if response is None:
        raise HTTPException(
            status_code=502,
            detail=f"Gemini API가 계속 과부하 상태입니다. 잠시 후 다시 시도해 주세요: {last_error}",
        )

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

    # response.parsed는 SDK가 response_schema(ChatModelOutput)에 맞춰 자동으로
    # 파싱해 준 결과다. 모델이 스스로 판단한 is_investment_directive만 신뢰하고,
    # 문자열 규칙 매칭은 더 이상 하지 않는다 — 문맥/의도 판단은 모델이 훨씬 낫다.
    output: ChatModelOutput | None = None
    if not blocked and has_valid_candidate:
        output = response.parsed
        if output is None:
            try:
                output = ChatModelOutput.model_validate_json(response.text)
            except (ValueError, ValidationError):
                output = None

    if (
        output is None
        or output.is_investment_directive
        # 모델의 자기판단(is_investment_directive)은 신뢰하되 100% 의존하지
        # 않는다 — body.message를 통한 프롬프트 인젝션으로 모델이 매매
        # 지시를 쓰면서 false라고 잘못 표시할 수 있어, 명백한 명령형 문구는
        # 모델 판단과 무관하게 서버가 독립적으로 한 번 더 검사한다.
        or _contains_directive_backstop(output.reply)
        or len(output.reply) > MAX_REPLY_LENGTH
        or not output.reply.endswith(REPLY_SUFFIX)
    ):
        reply_text = _build_safe_fallback_reply(market_data)
    else:
        reply_text = output.reply

    return ChatResponse(reply=reply_text, generated_at=date.today().isoformat())
