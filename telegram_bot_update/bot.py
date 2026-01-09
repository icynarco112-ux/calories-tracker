import os
import asyncio
import logging
from datetime import datetime
from typing import Dict

from aiogram import Bot, Dispatcher, types, F
from aiogram.filters import Command, StateFilter
from aiogram.enums import ParseMode
from aiogram.types import ReplyKeyboardMarkup, KeyboardButton, ReplyKeyboardRemove, InlineKeyboardMarkup, InlineKeyboardButton, CallbackQuery
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
import pytz

from reports import (
    generate_daily_report,
    generate_weekly_report,
    generate_monthly_report,
    get_user_by_telegram_id,
    register_user,
    fetch_api,
    API_BASE_URL
)
from profile import (
    get_profile,
    save_profile,
    log_weight,
    get_weight_history,
    format_profile_message,
    format_weight_history
)

# Configuration
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")

DAILY_REPORT_HOUR = int(os.getenv("DAILY_REPORT_HOUR", "23"))
DAILY_REPORT_MINUTE = int(os.getenv("DAILY_REPORT_MINUTE", "59"))
WEEKLY_REPORT_DAY = int(os.getenv("WEEKLY_REPORT_DAY", "6"))  # 0=Mon, 6=Sun
WEEKLY_REPORT_HOUR = int(os.getenv("WEEKLY_REPORT_HOUR", "20"))
MONTHLY_REPORT_DAY = int(os.getenv("MONTHLY_REPORT_DAY", "1"))
MONTHLY_REPORT_HOUR = int(os.getenv("MONTHLY_REPORT_HOUR", "12"))

TZ = os.getenv("TZ", "Europe/Moscow")

# Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Bot setup
bot = Bot(token=TELEGRAM_BOT_TOKEN)
dp = Dispatcher()
scheduler = AsyncIOScheduler(timezone=pytz.timezone(TZ))

# Store registered user chat IDs for scheduled reports
registered_users: Dict[str, str] = {}  # telegram_id -> user_code


# FSM States for profile setup wizard
class ProfileSetup(StatesGroup):
    height = State()
    current_weight = State()
    target_weight = State()
    birth_year = State()
    gender = State()
    activity = State()
    goal_type = State()  # New: user goal (lose/gain/maintain)
    rate = State()


# Keyboards for profile setup
gender_keyboard = ReplyKeyboardMarkup(
    keyboard=[
        [KeyboardButton(text="👨 Мужской"), KeyboardButton(text="👩 Женский")]
    ],
    resize_keyboard=True
)

activity_keyboard = ReplyKeyboardMarkup(
    keyboard=[
        [KeyboardButton(text="🪑 Сидячий")],
        [KeyboardButton(text="🚶 Лёгкая активность")],
        [KeyboardButton(text="🏃 Умеренная")],
        [KeyboardButton(text="💪 Высокая")],
        [KeyboardButton(text="🏋️ Очень высокая")],
    ],
    resize_keyboard=True
)

rate_keyboard = ReplyKeyboardMarkup(
    keyboard=[
        [KeyboardButton(text="🐢 Медленный (0.25 кг/нед)")],
        [KeyboardButton(text="🚶 Умеренный (0.5 кг/нед)")],
        [KeyboardButton(text="🏃 Быстрый (0.75 кг/нед)")],
    ],
    resize_keyboard=True
)

goal_type_keyboard = ReplyKeyboardMarkup(
    keyboard=[
        [KeyboardButton(text="📉 Похудеть")],
        [KeyboardButton(text="📈 Набрать массу")],
        [KeyboardButton(text="➡️ Поддерживать вес")],
    ],
    resize_keyboard=True
)

# Main keyboard with command buttons
main_keyboard = ReplyKeyboardMarkup(
    keyboard=[
        [KeyboardButton(text="📊 Сегодня"), KeyboardButton(text="📈 Неделя"), KeyboardButton(text="📅 Месяц")],
        [KeyboardButton(text="⚖️ Вес"), KeyboardButton(text="🎯 Прогресс"), KeyboardButton(text="👤 Профиль")],
        [KeyboardButton(text="🤖 AI-анализ"), KeyboardButton(text="❓ Помощь")]
    ],
    resize_keyboard=True,
    input_field_placeholder="Выберите команду или отправьте фото еды в Claude"
)

# AI menu inline keyboard
ai_menu_keyboard = InlineKeyboardMarkup(
    inline_keyboard=[
        [InlineKeyboardButton(text="📊 AI-анализ дня", callback_data="ai_analyze")],
        [InlineKeyboardButton(text="💡 Персональные советы", callback_data="ai_tips")],
        [InlineKeyboardButton(text="📈 Прогноз веса", callback_data="ai_predict")]
    ]
)

# Custom Instructions for Claude Project
CUSTOM_INSTRUCTIONS = """Ты — персональный помощник по отслеживанию питания. Твоя задача — анализировать фото еды и записывать данные о питании пользователя.

### Когда пользователь присылает фото еды:

1. **Определи блюдо** — Что на фото? Учитывай размер порции.

2. **Оцени питательную ценность:**
   - Калории (ккал)
   - Белки (г)
   - Жиры (г)
   - Углеводы (г)
   - Клетчатка (г)
   - Вода (мл, если применимо)

3. **Определи тип приёма пищи:**
   - breakfast (завтрак)
   - lunch (обед)
   - dinner (ужин)
   - snack (перекус)
   - other (другое)

4. **Оцени полезность от 1 до 10:**
   - 1-3: Вредная еда (фастфуд, много сахара/жира)
   - 4-6: Умеренно полезная
   - 7-10: Полезная еда (овощи, белок, цельные продукты)

5. **Используй инструмент add_meal** для записи данных

6. **Кратко подтверди запись** пользователю

### Формат ответа:

🍽 **[Название блюда]**

📊 Питательная ценность:
• Калории: X ккал
• Белки: X г
• Жиры: X г
• Углеводы: X г
• Клетчатка: X г

⭐ Оценка полезности: X/10
💡 [Краткий комментарий о блюде]

✅ Записано в трекер!

### Дополнительные команды:

- Если пользователь спрашивает "Что я съел сегодня?" — используй get_today_summary
- Если пользователь спрашивает про неделю — используй get_weekly_summary
- Если пользователь спрашивает про месяц — используй get_monthly_summary
- Если пользователь хочет посмотреть историю — используй get_meal_history

### Важно:

- Будь точным в оценках, но помни что без весов это приблизительно
- Если на фото несколько блюд — запиши каждое отдельно
- Если пользователь уточняет вес/порцию — учитывай это
- Отвечай кратко и по делу"""


async def load_registered_users():
    """Load registered users for scheduled reports."""
    # This would need to query the API for all users
    # For now, users will be added as they interact
    pass


async def send_scheduled_reports(report_type: str):
    """Send scheduled reports to all registered users."""
    for telegram_id, user_code in registered_users.items():
        try:
            if report_type == "daily":
                report = await generate_daily_report(telegram_id)
            elif report_type == "weekly":
                report = await generate_weekly_report(telegram_id)
            elif report_type == "monthly":
                report = await generate_monthly_report(telegram_id)
            else:
                continue

            await bot.send_message(
                chat_id=telegram_id,
                text=report,
                parse_mode=ParseMode.MARKDOWN
            )
            logger.info(f"Sent {report_type} report to {telegram_id}")
        except Exception as e:
            logger.error(f"Error sending {report_type} report to {telegram_id}: {e}")


async def broadcast_message(message_text: str) -> dict:
    """Send message to all registered users."""
    try:
        users_data = await fetch_api("/api/users/all")
        users = users_data.get("users", [])

        success_count = 0
        fail_count = 0

        for user in users:
            telegram_id = user.get("telegram_chat_id")
            if telegram_id:
                try:
                    await bot.send_message(
                        chat_id=telegram_id,
                        text=message_text,
                        parse_mode=ParseMode.MARKDOWN
                    )
                    success_count += 1
                    await asyncio.sleep(0.1)  # Rate limiting
                except Exception as e:
                    logger.error(f"Failed to send to {telegram_id}: {e}")
                    fail_count += 1

        return {"success": success_count, "failed": fail_count}
    except Exception as e:
        logger.error(f"Broadcast error: {e}")
        return {"error": str(e)}


@dp.message(Command("broadcast"))
async def cmd_broadcast(message: types.Message):
    """Admin command to broadcast message to all users."""
    ADMIN_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")

    if str(message.chat.id) != ADMIN_CHAT_ID:
        await message.answer("❌ У вас нет прав для этой команды.")
        return

    args = message.text.split(maxsplit=1)
    if len(args) < 2:
        await message.answer(
            "📤 *Broadcast*\n\n"
            "Использование: `/broadcast <текст сообщения>`\n\n"
            "Пример:\n"
            "`/broadcast Новое обновление!`",
            parse_mode=ParseMode.MARKDOWN
        )
        return

    broadcast_text = args[1]

    await message.answer("📤 Отправляю сообщение всем пользователям...")
    result = await broadcast_message(broadcast_text)

    if "error" in result:
        await message.answer(f"❌ Ошибка: {result['error']}")
    else:
        await message.answer(
            f"✅ Отправлено: {result['success']}\n"
            f"❌ Ошибок: {result['failed']}"
        )


@dp.message(Command("start"))
async def cmd_start(message: types.Message):
    """Handle /start command."""
    chat_id = str(message.chat.id)

    # Check if user is registered
    user = await get_user_by_telegram_id(chat_id)

    if user.get("user_code"):
        registered_users[chat_id] = user["user_code"]
        await message.answer(
            "🍎 *Calories Tracker Bot*\n\n"
            f"Вы уже зарегистрированы!\n"
            f"Ваш код: `{user['user_code']}`\n\n"
            "Используйте кнопки ниже для навигации 👇",
            parse_mode=ParseMode.MARKDOWN,
            reply_markup=main_keyboard
        )
    else:
        await message.answer(
            "🍎 *Calories Tracker Bot*\n\n"
            "Добро пожаловать! Для начала работы зарегистрируйтесь:\n\n"
            "/register — получить код для Claude\n\n"
            "После регистрации вы сможете:\n"
            "• Отправлять фото еды Claude для анализа\n"
            "• Получать отчёты о питании здесь\n"
            "• Отслеживать калории и БЖУ",
            parse_mode=ParseMode.MARKDOWN
        )


@dp.message(Command("register"))
async def cmd_register(message: types.Message):
    """Handle /register command - register new user."""
    chat_id = str(message.chat.id)
    username = message.from_user.username

    # Check if already registered
    existing = await get_user_by_telegram_id(chat_id)

    if existing.get("user_code"):
        registered_users[chat_id] = existing["user_code"]
        await message.answer(
            f"✅ Вы уже зарегистрированы!\n\n"
            f"Ваш код: `{existing['user_code']}`\n\n"
            f"Используйте /setup чтобы увидеть инструкции по настройке.",
            parse_mode=ParseMode.MARKDOWN
        )
        return

    # Register new user
    try:
        result = await register_user(chat_id, username)
        user_code = result["user_code"]
        registered_users[chat_id] = user_code
        logger.info(f"Registered new user: {chat_id} with code {user_code}")

        # Message 1: Success
        await message.answer(
            f"✅ *Регистрация успешна!*\n\n"
            f"Ваш персональный код: `{user_code}`\n\n"
            f"Теперь настроим Claude для отслеживания питания.\n"
            f"Следуйте инструкции ниже 👇",
            parse_mode=ParseMode.MARKDOWN
        )

        # Message 2: Connector setup
        await message.answer(
            f"*📋 Шаг 1: Подключите коннектор*\n\n"
            f"1. Откройте [claude.ai](https://claude.ai)\n"
            f"2. Нажмите ⚙️ Settings → Connectors\n"
            f"3. Нажмите 'Add custom connector'\n"
            f"4. Вставьте URL:\n"
            f"`{API_BASE_URL}/sse?code={user_code}`\n"
            f"5. Нажмите 'Add'",
            parse_mode=ParseMode.MARKDOWN,
            disable_web_page_preview=True
        )

        # Message 3: Project setup
        await message.answer(
            "*📁 Шаг 2: Создайте проект*\n\n"
            "1. На главной claude.ai нажмите 'Projects'\n"
            "2. Нажмите 'Create Project'\n"
            "3. Назовите его 'Трекер питания'\n"
            "4. Откройте настройки проекта (⚙️)\n"
            "5. В 'Custom Instructions' вставьте текст из следующего сообщения\n"
            "6. В 'Connectors' включите ваш коннектор",
            parse_mode=ParseMode.MARKDOWN
        )

        # Message 4: Custom Instructions
        await message.answer(
            "*📝 Шаг 3: Скопируйте инструкции*\n\n"
            "Вставьте этот текст в Custom Instructions проекта:",
            parse_mode=ParseMode.MARKDOWN
        )

        # Send instructions as plain text for easy copying
        await message.answer(CUSTOM_INSTRUCTIONS)

        # Message 5: Done with keyboard
        await message.answer(
            "✨ *Готово!*\n\n"
            "Теперь откройте проект 'Трекер питания' в Claude и отправьте фото еды — "
            "он проанализирует и запишет данные!\n\n"
            "Используйте кнопки ниже для навигации 👇",
            parse_mode=ParseMode.MARKDOWN,
            reply_markup=main_keyboard
        )

    except Exception as e:
        logger.error(f"Error registering user {chat_id}: {e}")
        await message.answer(
            f"❌ Ошибка регистрации: {e}\n"
            "Попробуйте позже или обратитесь к администратору.",
            parse_mode=ParseMode.MARKDOWN
        )


@dp.message(Command("setup"))
async def cmd_setup(message: types.Message):
    """Handle /setup command - show setup instructions."""
    chat_id = str(message.chat.id)

    user = await get_user_by_telegram_id(chat_id)

    if not user.get("user_code"):
        await message.answer(
            "❌ Вы не зарегистрированы.\n"
            "Используйте /register для регистрации.",
            parse_mode=ParseMode.MARKDOWN
        )
        return

    user_code = user["user_code"]

    # Connector setup
    await message.answer(
        f"*📋 Шаг 1: Подключите коннектор*\n\n"
        f"1. Откройте [claude.ai](https://claude.ai)\n"
        f"2. Нажмите ⚙️ Settings → Connectors\n"
        f"3. Нажмите 'Add custom connector'\n"
        f"4. Вставьте URL:\n"
        f"`{API_BASE_URL}/sse?code={user_code}`\n"
        f"5. Нажмите 'Add'",
        parse_mode=ParseMode.MARKDOWN,
        disable_web_page_preview=True
    )

    # Project setup
    await message.answer(
        "*📁 Шаг 2: Создайте проект*\n\n"
        "1. На главной claude.ai нажмите 'Projects'\n"
        "2. Нажмите 'Create Project'\n"
        "3. Назовите его 'Трекер питания'\n"
        "4. Откройте настройки проекта (⚙️)\n"
        "5. В 'Custom Instructions' вставьте текст из следующего сообщения\n"
        "6. В 'Connectors' включите ваш коннектор",
        parse_mode=ParseMode.MARKDOWN
    )

    # Custom Instructions
    await message.answer(
        "*📝 Шаг 3: Скопируйте инструкции*\n\n"
        "Вставьте этот текст в Custom Instructions проекта:",
        parse_mode=ParseMode.MARKDOWN
    )

    await message.answer(CUSTOM_INSTRUCTIONS)


@dp.message(Command("mycode"))
async def cmd_mycode(message: types.Message):
    """Handle /mycode command - show user's code."""
    chat_id = str(message.chat.id)

    user = await get_user_by_telegram_id(chat_id)

    if user.get("user_code"):
        await message.answer(
            f"🔑 *Ваш код:* `{user['user_code']}`\n\n"
            f"URL для Claude коннектора:\n"
            f"`{API_BASE_URL}/sse?code={user['user_code']}`",
            parse_mode=ParseMode.MARKDOWN
        )
    else:
        await message.answer(
            "❌ Вы не зарегистрированы.\n"
            "Используйте /register для регистрации.",
            parse_mode=ParseMode.MARKDOWN
        )


@dp.message(Command("help"))
async def cmd_help(message: types.Message):
    """Handle /help command."""
    await message.answer(
        "📖 *Как пользоваться*\n\n"
        "*Регистрация:*\n"
        "1. Напишите /register чтобы получить код\n"
        "2. Добавьте коннектор в Claude с вашим кодом\n"
        "3. Отправляйте фото еды Claude для анализа\n\n"
        "*Доступные команды:*\n"
        "/register — зарегистрироваться\n"
        "/profile — ваш профиль и цели\n"
        "/setgoal — настроить профиль\n"
        "/weight — записать текущий вес\n"
        "/today — статистика за сегодня\n"
        "/week — статистика за неделю\n"
        "/month — статистика за месяц\n\n"
        "*Автоматические отчёты:*\n"
        "• Ежедневно в 23:59\n"
        "• Еженедельно в воскресенье\n"
        "• Ежемесячно 1-го числа",
        parse_mode=ParseMode.MARKDOWN
    )


# === Profile Commands ===

@dp.message(Command("profile"))
async def cmd_profile(message: types.Message):
    """Handle /profile command - show user profile."""
    chat_id = str(message.chat.id)

    profile = await get_profile(chat_id)
    msg = format_profile_message(profile)

    await message.answer(msg, parse_mode=ParseMode.MARKDOWN, reply_markup=main_keyboard)


@dp.message(Command("weight"))
async def cmd_weight(message: types.Message):
    """Handle /weight command - log weight."""
    chat_id = str(message.chat.id)
    args = message.text.split()

    if len(args) < 2:
        await message.answer(
            "⚖️ *Запись веса*\n\n"
            "Укажите вес в кг:\n"
            "`/weight 75.5`\n\n"
            "Или с заметкой:\n"
            "`/weight 75.5 после тренировки`",
            parse_mode=ParseMode.MARKDOWN
        )
        return

    try:
        weight = float(args[1].replace(",", "."))
        notes = " ".join(args[2:]) if len(args) > 2 else None

        result = await log_weight(chat_id, weight, notes)

        if "error" in result:
            await message.answer(f"❌ Ошибка: {result['error']}")
            return

        change = result.get("change", 0)
        change_text = ""
        if change < 0:
            change_text = f"\n📉 Изменение: {change:.1f} кг"
        elif change > 0:
            change_text = f"\n📈 Изменение: +{change:.1f} кг"

        await message.answer(
            f"✅ Вес записан: *{weight} кг*{change_text}",
            parse_mode=ParseMode.MARKDOWN,
            reply_markup=main_keyboard
        )

    except ValueError:
        await message.answer("❌ Некорректный вес. Укажите число, например: /weight 75.5")


@dp.message(Command("weight_history"))
async def cmd_weight_history(message: types.Message):
    """Handle /weight_history command."""
    chat_id = str(message.chat.id)

    data = await get_weight_history(chat_id)
    msg = format_weight_history(data)

    await message.answer(msg, parse_mode=ParseMode.MARKDOWN, reply_markup=main_keyboard)


# === AI Analytics Commands ===

@dp.message(Command("analyze"))
async def cmd_analyze(message: types.Message):
    """AI analysis of today's nutrition."""
    chat_id = str(message.chat.id)

    await message.answer("🤖 Анализирую ваше питание...", reply_markup=main_keyboard)

    try:
        data = await fetch_api(f"/api/analyze?telegram_id={chat_id}")
        analysis = data.get("analysis", "Ошибка получения анализа")
        await message.answer(analysis, parse_mode=ParseMode.MARKDOWN, reply_markup=main_keyboard)
    except Exception as e:
        await message.answer(f"❌ Ошибка: {e}", reply_markup=main_keyboard)


@dp.message(Command("tips"))
async def cmd_tips(message: types.Message):
    """Get personalized nutrition tips from AI."""
    chat_id = str(message.chat.id)

    await message.answer("💡 Генерирую персональные советы...", reply_markup=main_keyboard)

    try:
        data = await fetch_api(f"/api/tips?telegram_id={chat_id}")
        tips = data.get("tips", "Ошибка получения советов")
        await message.answer(tips, parse_mode=ParseMode.MARKDOWN, reply_markup=main_keyboard)
    except Exception as e:
        await message.answer(f"❌ Ошибка: {e}", reply_markup=main_keyboard)


@dp.message(Command("predict"))
async def cmd_predict(message: types.Message):
    """Get weight prediction from AI."""
    chat_id = str(message.chat.id)

    await message.answer("📈 Рассчитываю прогноз...", reply_markup=main_keyboard)

    try:
        data = await fetch_api(f"/api/predict?telegram_id={chat_id}")
        prediction = data.get("prediction", "Ошибка получения прогноза")
        await message.answer(prediction, parse_mode=ParseMode.MARKDOWN, reply_markup=main_keyboard)
    except Exception as e:
        await message.answer(f"❌ Ошибка: {e}", reply_markup=main_keyboard)


# === Profile Setup Wizard ===

@dp.message(Command("setgoal"))
async def cmd_setgoal(message: types.Message, state: FSMContext):
    """Start profile setup wizard."""
    await state.set_state(ProfileSetup.height)
    await message.answer(
        "🎯 *Настройка профиля*\n\n"
        "Давай настроим твой профиль для расчёта целей.\n\n"
        "📏 *Шаг 1/7:* Укажи свой рост в см\n"
        "_Например: 175_",
        parse_mode=ParseMode.MARKDOWN,
        reply_markup=ReplyKeyboardRemove()
    )


@dp.message(ProfileSetup.height)
async def process_height(message: types.Message, state: FSMContext):
    """Process height input."""
    try:
        height = int(message.text)
        if height < 100 or height > 250:
            raise ValueError()
        await state.update_data(height=height)
        await state.set_state(ProfileSetup.current_weight)
        await message.answer(
            f"✅ Рост: {height} см\n\n"
            "⚖️ *Шаг 2/7:* Укажи текущий вес в кг\n"
            "_Например: 80.5_",
            parse_mode=ParseMode.MARKDOWN
        )
    except ValueError:
        await message.answer("❌ Укажи корректный рост (100-250 см)")


@dp.message(ProfileSetup.current_weight)
async def process_current_weight(message: types.Message, state: FSMContext):
    """Process current weight input."""
    try:
        weight = float(message.text.replace(",", "."))
        if weight < 30 or weight > 300:
            raise ValueError()
        await state.update_data(current_weight=weight)
        await state.set_state(ProfileSetup.target_weight)
        await message.answer(
            f"✅ Текущий вес: {weight} кг\n\n"
            "🎯 *Шаг 3/7:* Укажи целевой вес в кг\n"
            "_Например: 70_",
            parse_mode=ParseMode.MARKDOWN
        )
    except ValueError:
        await message.answer("❌ Укажи корректный вес (30-300 кг)")


@dp.message(ProfileSetup.target_weight)
async def process_target_weight(message: types.Message, state: FSMContext):
    """Process target weight input."""
    try:
        weight = float(message.text.replace(",", "."))
        if weight < 30 or weight > 300:
            raise ValueError()
        await state.update_data(target_weight=weight)
        await state.set_state(ProfileSetup.birth_year)
        await message.answer(
            f"✅ Целевой вес: {weight} кг\n\n"
            "📅 *Шаг 4/7:* Укажи год рождения\n"
            "_Например: 1990_",
            parse_mode=ParseMode.MARKDOWN
        )
    except ValueError:
        await message.answer("❌ Укажи корректный вес (30-300 кг)")


@dp.message(ProfileSetup.birth_year)
async def process_birth_year(message: types.Message, state: FSMContext):
    """Process birth year input."""
    try:
        year = int(message.text)
        current_year = datetime.now().year
        if year < 1920 or year > current_year - 10:
            raise ValueError()
        # Create birth_date as January 1st of that year
        birth_date = f"{year}-01-01"
        await state.update_data(birth_date=birth_date)
        await state.set_state(ProfileSetup.gender)
        await message.answer(
            f"✅ Год рождения: {year}\n\n"
            "👤 *Шаг 5/7:* Выбери пол\n"
            "_Это нужно для расчёта метаболизма_",
            parse_mode=ParseMode.MARKDOWN,
            reply_markup=gender_keyboard
        )
    except ValueError:
        await message.answer("❌ Укажи корректный год (1920-2010)")


@dp.message(ProfileSetup.gender)
async def process_gender(message: types.Message, state: FSMContext):
    """Process gender input."""
    text = message.text.lower()
    if "муж" in text:
        gender = "male"
    elif "жен" in text:
        gender = "female"
    else:
        await message.answer("❌ Выбери пол кнопкой", reply_markup=gender_keyboard)
        return

    await state.update_data(gender=gender)
    await state.set_state(ProfileSetup.activity)
    await message.answer(
        f"✅ Пол: {'Мужской' if gender == 'male' else 'Женский'}\n\n"
        "🏃 *Шаг 6/7:* Выбери уровень активности\n\n"
        "🪑 *Сидячий* — офисная работа, без тренировок\n"
        "🚶 *Лёгкая* — 1-2 тренировки в неделю\n"
        "🏃 *Умеренная* — 3-5 тренировок в неделю\n"
        "💪 *Высокая* — 6-7 тренировок в неделю\n"
        "🏋️ *Очень высокая* — профессиональный спорт",
        parse_mode=ParseMode.MARKDOWN,
        reply_markup=activity_keyboard
    )


@dp.message(ProfileSetup.activity)
async def process_activity(message: types.Message, state: FSMContext):
    """Process activity level input."""
    text = message.text.lower()

    activity_map = {
        "сидячий": "sedentary",
        "лёгк": "light",
        "легк": "light",
        "умерен": "moderate",
        "высок": "active",
        "очень": "very_active",
    }

    activity = None
    for key, value in activity_map.items():
        if key in text:
            activity = value
            break

    if not activity:
        await message.answer("❌ Выбери уровень активности кнопкой", reply_markup=activity_keyboard)
        return

    await state.update_data(activity=activity)
    await state.set_state(ProfileSetup.goal_type)
    await message.answer(
        "✅ Активность выбрана\n\n"
        "🎯 *Шаг 7/8:* Выбери свою цель\n\n"
        "📉 *Похудеть* — дефицит калорий\n"
        "📈 *Набрать массу* — профицит калорий\n"
        "➡️ *Поддерживать вес* — калории = расход",
        parse_mode=ParseMode.MARKDOWN,
        reply_markup=goal_type_keyboard
    )


@dp.message(ProfileSetup.goal_type)
async def process_goal_type(message: types.Message, state: FSMContext):
    """Process goal type input."""
    text = message.text.lower()

    goal_map = {
        "похудеть": "lose_weight",
        "похуд": "lose_weight",
        "набрать": "gain_weight",
        "масс": "gain_weight",
        "поддерж": "maintain",
    }

    goal_type = None
    for key, value in goal_map.items():
        if key in text:
            goal_type = value
            break

    if not goal_type:
        await message.answer("❌ Выбери цель кнопкой", reply_markup=goal_type_keyboard)
        return

    await state.update_data(goal_type=goal_type)

    # If maintain - skip rate selection
    if goal_type == "maintain":
        await state.update_data(rate="moderate")  # Default, not used for maintain
        await finish_profile_setup(message, state)
        return

    rate_text = "изменения веса" if goal_type == "gain_weight" else "похудения"
    await state.set_state(ProfileSetup.rate)
    await message.answer(
        "✅ Цель выбрана\n\n"
        f"⏱ *Шаг 8/8:* Выбери темп {rate_text}\n\n"
        "🐢 *Медленный* — 0.25 кг/нед (безопасный)\n"
        "🚶 *Умеренный* — 0.5 кг/нед (оптимальный)\n"
        "🏃 *Быстрый* — 0.75 кг/нед (интенсивный)",
        parse_mode=ParseMode.MARKDOWN,
        reply_markup=rate_keyboard
    )


@dp.message(ProfileSetup.rate)
async def process_rate(message: types.Message, state: FSMContext):
    """Process weight change rate and save profile."""
    text = message.text.lower()

    rate_map = {
        "медленн": "slow",
        "умерен": "moderate",
        "быстр": "fast",
    }

    rate = None
    for key, value in rate_map.items():
        if key in text:
            rate = value
            break

    if not rate:
        await message.answer("❌ Выбери темп кнопкой", reply_markup=rate_keyboard)
        return

    await state.update_data(rate=rate)
    await finish_profile_setup(message, state)


async def finish_profile_setup(message: types.Message, state: FSMContext):
    """Finish profile setup and save to API."""
    data = await state.get_data()
    chat_id = str(message.chat.id)

    result = await save_profile(
        telegram_id=chat_id,
        height_cm=data["height"],
        current_weight=data["current_weight"],
        target_weight=data["target_weight"],
        birth_date=data["birth_date"],
        gender=data["gender"],
        activity_level=data["activity"],
        goal_type=data.get("goal_type", "lose_weight"),
        weight_change_rate=data.get("rate", "moderate")
    )

    await state.clear()

    if "error" in result:
        await message.answer(
            f"❌ Ошибка сохранения: {result['error']}",
            reply_markup=main_keyboard
        )
        return

    goal_type = data.get("goal_type", "lose_weight")
    weight_diff = data["current_weight"] - data["target_weight"]

    goal_type_names = {
        "lose_weight": "📉 Похудение",
        "gain_weight": "📈 Набор массы",
        "maintain": "➡️ Поддержание",
    }

    weight_info = ""
    if goal_type == "lose_weight" and weight_diff > 0:
        weight_info = f"\n📉 Осталось сбросить: {weight_diff:.1f} кг"
    elif goal_type == "gain_weight" and weight_diff < 0:
        weight_info = f"\n📈 Осталось набрать: {abs(weight_diff):.1f} кг"

    await message.answer(
        "🎉 *Профиль настроен!*\n\n"
        f"🎯 *Цель:* {goal_type_names.get(goal_type, 'Не указана')}\n\n"
        f"📊 *Твои параметры:*\n"
        f"🔥 BMR: {result.get('bmr')} ккал\n"
        f"⚡ TDEE: {result.get('tdee')} ккал\n"
        f"🎯 *Дневная цель: {result.get('daily_calorie_goal')} ккал*\n"
        f"🥩 Белок: {result.get('protein_goal')} г/день"
        f"{weight_info}\n\n"
        "Теперь в отчётах будет показываться прогресс к цели!\n"
        "Используй /weight для записи веса.",
        parse_mode=ParseMode.MARKDOWN,
        reply_markup=main_keyboard
    )


@dp.message(Command("cancel"))
async def cmd_cancel(message: types.Message, state: FSMContext):
    """Cancel current operation."""
    current_state = await state.get_state()
    if current_state is None:
        await message.answer("Нечего отменять.", reply_markup=main_keyboard)
        return

    await state.clear()
    await message.answer("❌ Операция отменена.", reply_markup=main_keyboard)


@dp.message(Command("today"))
async def cmd_today(message: types.Message):
    """Handle /today command."""
    chat_id = str(message.chat.id)

    # Add to registered users if not there
    user = await get_user_by_telegram_id(chat_id)
    if user.get("user_code"):
        registered_users[chat_id] = user["user_code"]

    try:
        report = await generate_daily_report(chat_id)
        await message.answer(report, parse_mode=ParseMode.MARKDOWN, reply_markup=main_keyboard)
    except Exception as e:
        await message.answer(f"Ошибка: {e}", reply_markup=main_keyboard)


@dp.message(Command("week"))
async def cmd_week(message: types.Message):
    """Handle /week command."""
    chat_id = str(message.chat.id)

    # Add to registered users if not there
    user = await get_user_by_telegram_id(chat_id)
    if user.get("user_code"):
        registered_users[chat_id] = user["user_code"]

    try:
        report = await generate_weekly_report(chat_id)
        await message.answer(report, parse_mode=ParseMode.MARKDOWN, reply_markup=main_keyboard)
    except Exception as e:
        await message.answer(f"Ошибка: {e}", reply_markup=main_keyboard)


@dp.message(Command("month"))
async def cmd_month(message: types.Message):
    """Handle /month command."""
    chat_id = str(message.chat.id)

    # Add to registered users if not there
    user = await get_user_by_telegram_id(chat_id)
    if user.get("user_code"):
        registered_users[chat_id] = user["user_code"]

    try:
        report = await generate_monthly_report(chat_id)
        await message.answer(report, parse_mode=ParseMode.MARKDOWN, reply_markup=main_keyboard)
    except Exception as e:
        await message.answer(f"Ошибка: {e}", reply_markup=main_keyboard)


# Button handlers
@dp.message(lambda m: m.text == "📊 Сегодня")
async def btn_today(message: types.Message):
    """Handle 'Today' button."""
    await cmd_today(message)


@dp.message(lambda m: m.text == "📈 Неделя")
async def btn_week(message: types.Message):
    """Handle 'Week' button."""
    await cmd_week(message)


@dp.message(lambda m: m.text == "📅 Месяц")
async def btn_month(message: types.Message):
    """Handle 'Month' button."""
    await cmd_month(message)


@dp.message(lambda m: m.text == "⚖️ Вес")
async def btn_weight(message: types.Message):
    """Handle 'Weight' button."""
    await cmd_weight_history(message)


@dp.message(lambda m: m.text == "🎯 Прогресс")
async def btn_progress(message: types.Message):
    """Handle 'Progress' button - show profile with goals."""
    await cmd_profile(message)


@dp.message(lambda m: m.text == "👤 Профиль")
async def btn_profile(message: types.Message):
    """Handle 'Profile' button."""
    await cmd_profile(message)


@dp.message(lambda m: m.text == "🤖 AI-анализ")
async def btn_analyze(message: types.Message):
    """Handle 'AI Analysis' button - show AI menu."""
    await message.answer(
        "🤖 *AI-помощник*\n\nВыберите действие:",
        parse_mode=ParseMode.MARKDOWN,
        reply_markup=ai_menu_keyboard
    )


# AI menu callback handlers
@dp.callback_query(lambda c: c.data == "ai_analyze")
async def callback_ai_analyze(callback: CallbackQuery):
    """Handle AI analyze callback."""
    await callback.answer()
    chat_id = str(callback.message.chat.id)

    await callback.message.edit_text("🤖 Анализирую ваше питание...")

    try:
        data = await fetch_api(f"/api/analyze?telegram_id={chat_id}")
        analysis = data.get("analysis", "Ошибка получения анализа")
        await callback.message.edit_text(analysis, parse_mode=ParseMode.MARKDOWN)
    except Exception as e:
        await callback.message.edit_text(f"❌ Ошибка: {e}")


@dp.callback_query(lambda c: c.data == "ai_tips")
async def callback_ai_tips(callback: CallbackQuery):
    """Handle AI tips callback."""
    await callback.answer()
    chat_id = str(callback.message.chat.id)

    await callback.message.edit_text("💡 Генерирую персональные советы...")

    try:
        data = await fetch_api(f"/api/tips?telegram_id={chat_id}")
        tips = data.get("tips", "Ошибка получения советов")
        await callback.message.edit_text(tips, parse_mode=ParseMode.MARKDOWN)
    except Exception as e:
        await callback.message.edit_text(f"❌ Ошибка: {e}")


@dp.callback_query(lambda c: c.data == "ai_predict")
async def callback_ai_predict(callback: CallbackQuery):
    """Handle AI predict callback."""
    await callback.answer()
    chat_id = str(callback.message.chat.id)

    await callback.message.edit_text("📈 Рассчитываю прогноз...")

    try:
        data = await fetch_api(f"/api/predict?telegram_id={chat_id}")
        prediction = data.get("prediction", "Ошибка получения прогноза")
        await callback.message.edit_text(prediction, parse_mode=ParseMode.MARKDOWN)
    except Exception as e:
        await callback.message.edit_text(f"❌ Ошибка: {e}")


@dp.message(lambda m: m.text == "❓ Помощь")
async def btn_help(message: types.Message):
    """Handle 'Help' button."""
    await cmd_help(message)


def setup_scheduler():
    """Setup scheduled tasks."""
    # Daily report
    scheduler.add_job(
        send_scheduled_reports,
        CronTrigger(hour=DAILY_REPORT_HOUR, minute=DAILY_REPORT_MINUTE),
        args=["daily"],
        id="daily_report"
    )

    # Weekly report (Sunday)
    scheduler.add_job(
        send_scheduled_reports,
        CronTrigger(day_of_week=WEEKLY_REPORT_DAY, hour=WEEKLY_REPORT_HOUR, minute=0),
        args=["weekly"],
        id="weekly_report"
    )

    # Monthly report (1st of each month)
    scheduler.add_job(
        send_scheduled_reports,
        CronTrigger(day=MONTHLY_REPORT_DAY, hour=MONTHLY_REPORT_HOUR, minute=0),
        args=["monthly"],
        id="monthly_report"
    )

    scheduler.start()
    logger.info("Scheduler started with jobs:")
    logger.info(f"  - Daily report at {DAILY_REPORT_HOUR}:{DAILY_REPORT_MINUTE:02d}")
    logger.info(f"  - Weekly report on day {WEEKLY_REPORT_DAY} at {WEEKLY_REPORT_HOUR}:00")
    logger.info(f"  - Monthly report on day {MONTHLY_REPORT_DAY} at {MONTHLY_REPORT_HOUR}:00")


async def main():
    """Main function."""
    logger.info("Starting Calories Tracker Bot (Multi-user version)...")
    logger.info(f"Using Cloudflare API: {API_BASE_URL}")

    # Setup scheduler
    setup_scheduler()

    # Start polling
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
