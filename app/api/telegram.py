
import asyncio
import os
from contextlib import suppress

import httpx
from dotenv import load_dotenv
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

load_dotenv()

router = APIRouter(prefix="/api/telegram", tags=["Telegram"])

API_URL = "http://127.0.0.1:8765"

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
VAULT_PATH = os.getenv("EHO_VAULT_PATH", "").strip()

ALLOWED_IDS = {
    value.strip()
    for value in os.getenv(
        "TELEGRAM_ALLOWED_USER_IDS", ""
    ).split(",")
    if value.strip()
}


class TelegramLLMConfig(BaseModel):
    llm_base_url: str = Field(min_length=1, max_length=2048)
    llm_model: str = Field(min_length=1, max_length=512)
    llm_api_key: str = Field(default="", max_length=4096)


_bot: Application | None = None
_lock = asyncio.Lock()
_llm_config: TelegramLLMConfig | None = None


@router.post("/config")
async def update_telegram_config(config: TelegramLLMConfig):
    """Получает актуальные настройки модели из плагина Obsidian."""
    global _llm_config

    if not config.llm_base_url.strip():
        raise HTTPException(
            status_code=400,
            detail="Не задан URL API.",
        )

    if not config.llm_model.strip():
        raise HTTPException(
            status_code=400,
            detail="Не задана модель.",
        )

    _llm_config = config

    return {"status": "ok", "message": "Настройки модели обновлены."}


async def start_command(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
):
    message = update.effective_message
    user = update.effective_user

    if not message or not user:
        return

    if str(user.id) not in ALLOWED_IDS:
        await message.reply_text("Доступ запрещён.")
        return

    await message.reply_text(
        "Eho на связи. Отправь описание проблемы."
    )


async def handle_message(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
):
    message = update.effective_message
    user = update.effective_user

    if not message or not user or not message.text:
        return

    if str(user.id) not in ALLOWED_IDS:
        await message.reply_text("Доступ запрещён.")
        return

    if not VAULT_PATH:
        await message.reply_text(
            "Не настроен EHO_VAULT_PATH в .env."
        )
        return

    config = _llm_config

    if config is None:
        await message.reply_text(
            "Настройки модели ещё не получены из Obsidian. "
            "Открой настройки Eho или запусти анализ из плагина."
        )
        return

    status = await message.reply_text(
        "Анализирую запрос через Eho…"
    )

    try:
        async with httpx.AsyncClient(timeout=240) as client:
            response = await client.post(
                f"{API_URL}/api/analyze",
                json={
                    "query": message.text,
                    "vault_path": VAULT_PATH,
                    "limit": 6,
                    "llm_base_url": config.llm_base_url,
                    "llm_model": config.llm_model,
                    "llm_api_key": config.llm_api_key,
                },
            )
            response.raise_for_status()
            result = response.json()

        answer = result.get(
            "answer",
            "Eho не вернул текст ответа.",
        )

        with suppress(Exception):
            await status.delete()

        for offset in range(0, len(answer), 4000):
            await message.reply_text(
                answer[offset:offset + 4000]
            )

    except httpx.HTTPStatusError as exc:
        detail = exc.response.text[:1000]

        with suppress(Exception):
            await status.edit_text(
                f"Ошибка Eho API (HTTP {exc.response.status_code}):\n"
                f"{detail}"
            )

    except Exception:
        with suppress(Exception):
            await status.edit_text(
                "Не удалось выполнить анализ. "
                "Проверь состояние Eho API и LM Studio."
            )


@router.get("/status")
async def telegram_status():
    return {
        "enabled": _bot is not None,
        "configured": bool(
            BOT_TOKEN and ALLOWED_IDS and VAULT_PATH
        ),
        "llm_configured": _llm_config is not None,
    }


@router.post("/start")
async def telegram_start():
    global _bot

    async with _lock:
        if _bot is not None:
            return {
                "enabled": True,
                "message": "Бот уже запущен.",
            }

        if not BOT_TOKEN:
            raise HTTPException(
                status_code=400,
                detail="Не задан TELEGRAM_BOT_TOKEN в .env.",
            )

        if not ALLOWED_IDS:
            raise HTTPException(
                status_code=400,
                detail="Не заданы TELEGRAM_ALLOWED_USER_IDS в .env.",
            )

        if not VAULT_PATH:
            raise HTTPException(
                status_code=400,
                detail="Не задан EHO_VAULT_PATH в .env.",
            )

        bot = None

        try:
            bot = (
                Application.builder()
                .token(BOT_TOKEN)
                .build()
            )

            bot.add_handler(
                CommandHandler("start", start_command)
            )

            bot.add_handler(
                MessageHandler(
                    filters.TEXT & ~filters.COMMAND,
                    handle_message,
                )
            )

            await bot.initialize()
            await bot.start()

            if bot.updater is None:
                raise RuntimeError(
                    "Telegram updater недоступен."
                )

            await bot.updater.start_polling()
            _bot = bot

            return {
                "enabled": True,
                "message": "Telegram-бот запущен.",
            }

        except Exception as exc:
            if bot is not None:
                with suppress(Exception):
                    if bot.updater and bot.updater.running:
                        await bot.updater.stop()

                with suppress(Exception):
                    if bot.running:
                        await bot.stop()

                with suppress(Exception):
                    await bot.shutdown()

            raise HTTPException(
                status_code=502,
                detail=(
                    "Не удалось запустить Telegram-бота: "
                    f"{exc}"
                ),
            ) from exc


@router.post("/stop")
async def telegram_stop():
    global _bot

    async with _lock:
        if _bot is None:
            return {
                "enabled": False,
                "message": "Бот уже остановлен.",
            }

        bot = _bot
        _bot = None

        try:
            if bot.updater and bot.updater.running:
                await bot.updater.stop()

            if bot.running:
                await bot.stop()

            await bot.shutdown()

            return {
                "enabled": False,
                "message": "Telegram-бот остановлен.",
            }

        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail=f"Ошибка остановки Telegram-бота: {exc}",
            ) from exc
