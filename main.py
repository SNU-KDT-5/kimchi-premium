"""김치프리미엄 데이터 설명 챗봇 백엔드 (FastAPI)

- POST /api/chat 하나만 제공한다.
- 세션당 최대 10회, 서버 전체 하루 100회로 호출을 이중 제한한다 (메모리 기반, DB 없음).
- LLM 호출은 매 요청 1회(Tool Use 없이 data/current.json을 시스템 프롬프트에 직접 삽입)로 고정한다.
"""

import json
import os
from collections import defaultdict
from datetime import date
from pathlib import Path

import google.generativeai as genai
from google.api_core.exceptions import GoogleAPICallError
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
MODEL_NAME = "gemini-flash-latest"

BASE_DIR = Path(__file__).resolve().parent
DATA_PATH = BASE_DIR / "data" / "current.json"

SESSION_CHAT_LIMIT = 10
DAILY_CHAT_LIMIT = 100

BANNED_WORDS = ["매수", "매도", "사세요", "파세요"]
DISCLAIMER = "(본 내용은 투자 조언이 아니며 데이터 해석 참고용입니다.)"
SAFE_FALLBACK_REPLY = (
    "죄송합니다. 투자 행동을 유도하는 표현이 포함되어 있어 답변을 대체합니다. "
    "데이터 수치의 의미에 대해 다시 질문해 주세요. " + DISCLAIMER
)

if not GEMINI_API_KEY:
    # 서버는 계속 기동되지만(문서 확인 등은 가능), /api/chat 호출 시 명확한 에러를 반환한다.
    print(
        "\n⚠️  GEMINI_API_KEY가 설정되어 있지 않습니다.\n"
        "   .env 파일을 만들고 GEMINI_API_KEY=AI... 형식으로 키를 추가한 뒤\n"
        "   서버를 다시 시작하세요. (.env.example 참고)\n"
        "   키가 없어도 서버는 기동되지만 /api/chat 호출은 500 에러를 반환합니다.\n"
    )
else:
    genai.configure(api_key=GEMINI_API_KEY)

app = FastAPI(title="Kimchi Premium Chatbot API")

# 개발 중엔 전체 허용. 배포 직전에 프론트 실제 도메인으로 좁힐 것!
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 비용 제어용 인메모리 카운터. 날짜가 바뀌면 전부 리셋된다.
_usage_state = {
    "date": date.today(),
    "daily_count": 0,
    "session_counts": defaultdict(int),
}


def _reset_counters_if_new_day() -> None:
    today = date.today()
    if _usage_state["date"] != today:
        _usage_state["date"] = today
        _usage_state["daily_count"] = 0
        _usage_state["session_counts"] = defaultdict(int)


def _load_market_data() -> dict:
    if not DATA_PATH.exists():
        raise HTTPException(
            status_code=500,
            detail="시장 데이터 파일(data/current.json)을 찾을 수 없습니다.",
        )
    try:
        with DATA_PATH.open("r", encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=500,
            detail="시장 데이터 파일(data/current.json)의 형식이 올바르지 않습니다.",
        ) from exc


def _build_system_prompt(data: dict) -> str:
    # Tool Use(함수 호출) 대신, 매 요청마다 서버가 먼저 data/current.json을 읽어
    # 그 내용을 시스템 프롬프트에 텍스트로 끼워 넣는다.
    # 이렇게 하면 "데이터 조회 tool_use -> tool_result -> 최종 응답"으로 이어지는
    # API 왕복이 1회로 줄어들어 속도가 빨라지고 비용도 절감된다.
    return f"""당신은 '김치프리미엄' 데이터를 설명해주는 금융 데이터 해설 챗봇입니다.

다음은 현재 시점의 실제 데이터입니다. 답변은 반드시 이 수치에 근거해야 합니다:
- 프리미엄(premium_pct): {data.get("premium_pct")}%
- 원/달러 환율(fx_rate): {data.get("fx_rate")}
- USDT 상장(2024-06-07) 이후 전체 기간 대비 백분위(percentile): {data.get("percentile")}
- 최근 이벤트(recent_event): {data.get("recent_event")}

[답변 원칙 - 반드시 지킬 것]
1. 위 데이터의 실제 수치를 근거로만 답변하세요. 데이터에 없는 내용은 추측해서 말하지 마세요.
2. "매수", "매도", "지금 사세요", "지금 파세요"와 같은 투자 행동 지시나 수익률 예측은 절대 하지 마세요.
3. 데이터가 무엇을 의미하는지는 설명하되, 최종 판단은 항상 사용자 본인이 하도록 유도하세요. AI가 대신 판단해주지 마세요.
4. 반드시 존댓말을 사용하고, 답변 전체 길이는 200자 이내로 작성하세요.
5. 답변의 맨 마지막에는 반드시 아래 문구를 그대로 추가하세요:
"{DISCLAIMER}"
"""


def _violates_safety_policy(reply: str) -> bool:
    return any(word in reply for word in BANNED_WORDS)


class ChatRequest(BaseModel):
    message: str


class ChatResponse(BaseModel):
    reply: str
    generated_at: str


@app.post("/api/chat", response_model=ChatResponse)
async def chat(body: ChatRequest, x_session_id: str = Header(...)) -> ChatResponse:
    if not GEMINI_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="GEMINI_API_KEY가 설정되지 않았습니다. .env 파일에 키를 추가한 뒤 서버를 다시 시작하세요.",
        )

    _reset_counters_if_new_day()

    if _usage_state["daily_count"] >= DAILY_CHAT_LIMIT:
        raise HTTPException(
            status_code=429,
            detail="오늘의 대화 한도에 도달했습니다. 내일 다시 이용해 주세요.",
        )

    if _usage_state["session_counts"][x_session_id] >= SESSION_CHAT_LIMIT:
        raise HTTPException(
            status_code=429,
            detail="이 세션에서 사용 가능한 채팅 횟수를 모두 사용했습니다.",
        )

    # 제한을 통과한 시점에 슬롯을 즉시 예약한다 (이 지점까지는 await가 없어 동시 요청에도 안전).
    _usage_state["daily_count"] += 1
    _usage_state["session_counts"][x_session_id] += 1

    market_data = _load_market_data()
    system_prompt = _build_system_prompt(market_data)

    try:
        model = genai.GenerativeModel(
            MODEL_NAME,
            system_instruction=system_prompt,
        )
        response = model.generate_content(body.message)
        reply_text = response.text
    except GoogleAPICallError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Gemini API 호출에 실패했습니다: {exc.message}",
        ) from exc

    # 2차 안전장치: 금지 단어가 섞여 나오면 안전한 대체 메시지로 교체한다.
    if _violates_safety_policy(reply_text):
        reply_text = SAFE_FALLBACK_REPLY

    return ChatResponse(reply=reply_text, generated_at=date.today().isoformat())
