import httpx
import secrets
import string
from datetime import datetime

# Cloudflare API URL
API_BASE_URL = "https://calories-mcp.icynarco112.workers.dev"


def generate_user_code(length: int = 8) -> str:
    """Generate a random user code."""
    alphabet = string.ascii_uppercase + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(length))


async def fetch_api(endpoint: str, method: str = "GET", data: dict = None) -> dict:
    """Fetch data from Cloudflare API."""
    async with httpx.AsyncClient() as client:
        if method == "POST":
            response = await client.post(
                f"{API_BASE_URL}{endpoint}",
                json=data,
                timeout=10
            )
        else:
            response = await client.get(f"{API_BASE_URL}{endpoint}", timeout=10)
        response.raise_for_status()
        return response.json()


async def get_user_by_telegram_id(telegram_id: str) -> dict:
    """Get user by Telegram ID."""
    try:
        return await fetch_api(f"/api/user?telegram_id={telegram_id}")
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            return {}
        raise


async def register_user(telegram_id: str, username: str = None) -> dict:
    """Register a new user."""
    user_code = generate_user_code()
    await fetch_api("/api/register", method="POST", data={
        "telegram_id": telegram_id,
        "username": username,
        "user_code": user_code
    })
    return {"user_code": user_code}


async def get_today_activities(telegram_id: str) -> dict:
    """Get today's activities for a user."""
    try:
        return await fetch_api(f"/api/activities/today?telegram_id={telegram_id}")
    except:
        return {"activities": [], "total_burned": 0}


def format_activity_type(activity_type: str) -> str:
    """Format activity type to Russian."""
    activity_names = {
        "walking": "Ходьба",
        "running": "Бег",
        "cycling": "Велосипед",
        "gym": "Тренажёрный зал",
        "swimming": "Плавание",
        "yoga": "Йога",
        "other": "Другое",
    }
    return activity_names.get(activity_type, activity_type)


async def generate_daily_report(telegram_id: str) -> str:
    """Generate daily nutrition report from Cloudflare API."""
    try:
        data = await fetch_api(f"/api/today?telegram_id={telegram_id}")
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            return "📊 *Отчёт за сегодня*\n\nВы не зарегистрированы. Используйте /register"
        return f"📊 *Отчёт за сегодня*\n\nОшибка получения данных: {e}"
    except Exception as e:
        return f"📊 *Отчёт за сегодня*\n\nОшибка получения данных: {e}"

    # Fetch activities
    activities_data = await get_today_activities(telegram_id)
    activities = activities_data.get("activities", [])
    total_burned = activities_data.get("total_burned", 0)

    summary = data.get("summary", {})
    meals = data.get("meals", [])

    if not meals or summary.get("meal_count", 0) == 0:
        return "📊 *Отчёт за сегодня*\n\nСегодня приёмов пищи не зафиксировано."

    report = f"📊 *Отчёт за {data.get('date', 'сегодня')}*\n\n"
    report += f"🔥 *Калории:* {summary.get('total_calories', 0)} ккал\n"
    report += f"🥩 *Белки:* {summary.get('total_proteins', 0):.1f} г\n"
    report += f"🧈 *Жиры:* {summary.get('total_fats', 0):.1f} г\n"
    report += f"🍞 *Углеводы:* {summary.get('total_carbs', 0):.1f} г\n"
    report += f"🥬 *Клетчатка:* {summary.get('total_fiber', 0):.1f} г\n"
    report += f"💧 *Вода:* {summary.get('total_water', 0)} мл\n"
    report += f"⭐ *Средняя полезность:* {summary.get('avg_healthiness', 0):.1f}/10\n\n"

    report += "*Приёмы пищи:*\n"
    for meal in meals:
        time_str = meal.get("time", "??:??")
        health_score = meal.get("healthiness_score", 5)
        health_emoji = "🟢" if health_score >= 7 else "🟡" if health_score >= 4 else "🔴"
        report += f"• {time_str} — {meal.get('meal_name', 'Неизвестно')} ({meal.get('calories', 0)} ккал) {health_emoji}\n"

    # Add activities section
    if activities:
        report += "\n*Активность:*\n"
        for activity in activities:
            time_str = activity.get("time", "??:??")
            activity_type = format_activity_type(activity.get("activity_type", "other"))
            duration = activity.get("duration_minutes", 0)
            burned = activity.get("calories_burned", 0)
            report += f"• {time_str} — {activity_type} ({duration} мин, -{burned} ккал)\n"

        report += f"\n🏃 *Сожжено:* {total_burned} ккал\n"

        # Calculate net calories
        total_consumed = summary.get("total_calories", 0)
        net_calories = total_consumed - total_burned
        report += f"📊 *Нетто калорий:* {net_calories} ккал\n"

    # Add AI analysis
    try:
        ai_data = await fetch_api(f"/api/analyze?telegram_id={telegram_id}")
        if ai_data.get("analysis"):
            report += f"\n{ai_data['analysis']}"
    except:
        pass  # AI is optional, don't fail the report if it's unavailable

    return report


async def generate_weekly_report(telegram_id: str) -> str:
    """Generate weekly nutrition report from Cloudflare API."""
    try:
        data = await fetch_api(f"/api/week?telegram_id={telegram_id}")
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            return "📈 *Недельный отчёт*\n\nВы не зарегистрированы. Используйте /register"
        return f"📈 *Недельный отчёт*\n\nОшибка получения данных: {e}"
    except Exception as e:
        return f"📈 *Недельный отчёт*\n\nОшибка получения данных: {e}"

    total = data.get("total", {})
    daily_breakdown = data.get("daily_breakdown", [])

    if not daily_breakdown or total.get("meal_count", 0) == 0:
        return "📈 *Недельный отчёт*\n\nНет данных за последние 7 дней."

    total_cal = total.get("total_calories", 0) or 0
    avg_daily_cal = total_cal / 7 if total_cal else 0

    report = f"📈 *Недельный отчёт*\n"
    report += f"_{data.get('period', 'Последние 7 дней')}_\n\n"

    report += "*По дням:*\n"
    for day in daily_breakdown:
        day_str = day.get("date", "??")
        if len(day_str) > 5:
            day_str = day_str[5:]  # Remove year
        day_str = day_str.replace("-", ".")
        cal = day.get("total_calories", 0) or 0
        report += f"`{day_str}` ➜ {cal} ккал\n"

    report += f"\n*Итого за неделю:*\n"
    report += f"🔥 Калории: {total_cal} ккал (≈{avg_daily_cal:.0f}/день)\n"
    report += f"🥩 Белки: {total.get('total_proteins', 0) or 0:.1f} г\n"
    report += f"🧈 Жиры: {total.get('total_fats', 0) or 0:.1f} г\n"
    report += f"🍞 Углеводы: {total.get('total_carbs', 0) or 0:.1f} г\n"
    total_water = total.get('total_water', 0) or 0
    avg_water = total_water / 7 if total_water else 0
    report += f"💧 Вода: {total_water} мл (≈{avg_water:.0f}/день)\n"
    report += f"⭐ Средняя полезность: {total.get('avg_healthiness', 0) or 0:.1f}/10\n"
    report += f"📝 Всего приёмов пищи: {total.get('meal_count', 0)}\n"

    # Add AI analysis
    try:
        ai_data = await fetch_api(f"/api/analyze/week?telegram_id={telegram_id}")
        if ai_data.get("analysis"):
            report += f"\n{ai_data['analysis']}"
    except:
        pass  # AI is optional

    return report


async def generate_monthly_report(telegram_id: str) -> str:
    """Generate monthly nutrition report from Cloudflare API."""
    try:
        data = await fetch_api(f"/api/month?telegram_id={telegram_id}")
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            return "📅 *Месячный отчёт*\n\nВы не зарегистрированы. Используйте /register"
        return f"📅 *Месячный отчёт*\n\nОшибка получения данных: {e}"
    except Exception as e:
        return f"📅 *Месячный отчёт*\n\nОшибка получения данных: {e}"

    summary = data.get("summary", {})

    if not summary or summary.get("meal_count", 0) == 0:
        return "📅 *Месячный отчёт*\n\nНет данных за текущий месяц."

    total_cal = summary.get("total_calories", 0) or 0
    days_tracked = summary.get("days_tracked", 1) or 1
    avg_daily_cal = total_cal / days_tracked if total_cal else 0

    report = f"📅 *Месячный отчёт*\n"
    report += f"_{data.get('period', datetime.now().strftime('%Y-%m'))}_\n\n"

    report += f"*Общая статистика:*\n"
    report += f"📆 Дней отслеживания: {days_tracked}\n"
    report += f"📝 Всего приёмов пищи: {summary.get('meal_count', 0)}\n\n"

    report += f"*Питательные вещества:*\n"
    report += f"🔥 Калории: {total_cal} ккал (≈{avg_daily_cal:.0f}/день)\n"
    report += f"🥩 Белки: {summary.get('total_proteins', 0) or 0:.1f} г\n"
    report += f"🧈 Жиры: {summary.get('total_fats', 0) or 0:.1f} г\n"
    report += f"🍞 Углеводы: {summary.get('total_carbs', 0) or 0:.1f} г\n"
    report += f"🥬 Клетчатка: {summary.get('total_fiber', 0) or 0:.1f} г\n"
    total_water = summary.get('total_water', 0) or 0
    avg_water = total_water / days_tracked if total_water else 0
    report += f"💧 Вода: {total_water} мл (≈{avg_water:.0f}/день)\n"
    report += f"⭐ Средняя полезность: {summary.get('avg_healthiness', 0) or 0:.1f}/10\n"

    # Add AI analysis
    try:
        ai_data = await fetch_api(f"/api/analyze/month?telegram_id={telegram_id}")
        if ai_data.get("analysis"):
            report += f"\n{ai_data['analysis']}"
    except:
        pass  # AI is optional

    return report
