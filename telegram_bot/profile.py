import httpx
from reports import API_BASE_URL, fetch_api


async def get_profile(telegram_id: str) -> dict:
    """Get user profile from API."""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{API_BASE_URL}/api/profile",
                params={"telegram_id": telegram_id},
                timeout=10
            )
            return response.json()
    except Exception as e:
        return {"error": str(e)}


async def save_profile(
    telegram_id: str,
    height_cm: int,
    current_weight: float,
    target_weight: float,
    birth_date: str,
    gender: str,
    activity_level: str,
    goal_type: str = "lose_weight",
    weight_change_rate: str = "moderate"
) -> dict:
    """Save user profile to API."""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{API_BASE_URL}/api/profile",
                json={
                    "telegram_id": telegram_id,
                    "height_cm": height_cm,
                    "current_weight": current_weight,
                    "target_weight": target_weight,
                    "birth_date": birth_date,
                    "gender": gender,
                    "activity_level": activity_level,
                    "goal_type": goal_type,
                    "weight_loss_rate": weight_change_rate,
                },
                timeout=10
            )
            return response.json()
    except Exception as e:
        return {"error": str(e)}


async def log_weight(telegram_id: str, weight: float, notes: str = None) -> dict:
    """Log weight to API."""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{API_BASE_URL}/api/weight",
                json={
                    "telegram_id": telegram_id,
                    "weight": weight,
                    "notes": notes,
                },
                timeout=10
            )
            return response.json()
    except Exception as e:
        return {"error": str(e)}


async def get_weight_history(telegram_id: str) -> dict:
    """Get weight history from API."""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{API_BASE_URL}/api/weight_history",
                params={"telegram_id": telegram_id},
                timeout=10
            )
            return response.json()
    except Exception as e:
        return {"error": str(e)}


def format_profile_message(profile: dict) -> str:
    """Format profile data as a message."""
    if "error" in profile:
        if profile.get("error") == "Profile not set":
            return (
                "👤 *Профиль не настроен*\n\n"
                "Используйте /setgoal чтобы настроить профиль\n"
                "и получить персональные рекомендации по калориям."
            )
        return f"❌ Ошибка: {profile['error']}"

    # Calculate progress
    current = profile.get("current_weight", 0)
    target = profile.get("target_weight", 0)
    weight_to_lose = current - target if current > target else 0

    # Activity level names
    activity_names = {
        "sedentary": "Сидячий",
        "light": "Лёгкая активность",
        "moderate": "Умеренная",
        "active": "Высокая",
        "very_active": "Очень высокая",
    }

    # Weight change rate names
    rate_names = {
        "slow": "Медленный (0.25 кг/нед)",
        "moderate": "Умеренный (0.5 кг/нед)",
        "fast": "Быстрый (0.75 кг/нед)",
    }

    # Goal type names
    goal_type_names = {
        "lose_weight": "📉 Похудение",
        "gain_weight": "📈 Набор массы",
        "maintain": "➡️ Поддержание веса",
    }

    goal_type = profile.get("goal_type", "lose_weight")

    msg = "👤 *Ваш профиль*\n\n"
    msg += f"🎯 *Цель:* {goal_type_names.get(goal_type, 'Не указана')}\n\n"

    msg += "*Параметры:*\n"
    msg += f"📏 Рост: {profile.get('height_cm')} см\n"
    msg += f"⚖️ Текущий вес: {profile.get('current_weight')} кг\n"
    msg += f"🎯 Целевой вес: {profile.get('target_weight')} кг\n"
    msg += f"👤 Пол: {'Мужской' if profile.get('gender') == 'male' else 'Женский'}\n"
    msg += f"🏃 Активность: {activity_names.get(profile.get('activity_level'), profile.get('activity_level'))}\n\n"

    msg += "*Рассчитанные цели:*\n"
    msg += f"🔥 BMR (базовый метаболизм): {profile.get('bmr')} ккал\n"
    msg += f"⚡ TDEE (суточный расход): {profile.get('tdee')} ккал\n"
    msg += f"🎯 Дневная цель: *{profile.get('daily_calorie_goal')} ккал*\n"
    msg += f"🥩 Цель белка: {profile.get('protein_goal')} г\n\n"

    # Show progress based on goal type
    weight_diff = current - target

    if goal_type == "lose_weight" and weight_diff > 0:
        msg += "*Прогресс:*\n"
        msg += f"📉 Осталось сбросить: {weight_diff:.1f} кг\n"
    elif goal_type == "gain_weight" and weight_diff < 0:
        msg += "*Прогресс:*\n"
        msg += f"📈 Осталось набрать: {abs(weight_diff):.1f} кг\n"
    elif goal_type == "maintain":
        msg += "*Прогресс:*\n"
        msg += "➡️ Цель: поддержание текущего веса\n"

    # Show actual rate if available (for non-maintain goals)
    if goal_type != "maintain":
        actual_rate = profile.get("actual_weekly_rate")
        actual_deficit = profile.get("actual_daily_deficit")
        avg_cal = profile.get("avg_daily_calories")
        days_tracked = profile.get("days_tracked", 0)

        if actual_rate is not None and days_tracked >= 1:
            # Format actual rate based on goal
            if actual_rate > 0:
                rate_emoji = "📉" if goal_type == "lose_weight" else "⚠️"
                rate_text = f"-{actual_rate:.2f} кг/нед"
                if goal_type == "lose_weight":
                    if actual_rate > 1.0:
                        rate_text += " (быстро!)"
                    elif actual_rate < 0.3:
                        rate_text += " (медленно)"
            elif actual_rate < 0:
                rate_emoji = "📈" if goal_type == "gain_weight" else "⚠️"
                rate_text = f"+{abs(actual_rate):.2f} кг/нед"
                if goal_type == "gain_weight":
                    if abs(actual_rate) > 1.0:
                        rate_text += " (быстро!)"
            else:
                rate_emoji = "➡️"
                rate_text = "стабильный вес"

            msg += f"{rate_emoji} Фактический темп: *{rate_text}*\n"
            deficit_text = "дефицит" if actual_deficit > 0 else "профицит"
            msg += f"📊 Среднее: {avg_cal} ккал/день ({deficit_text}: {abs(actual_deficit):.0f})\n"

            # Estimate time to goal
            weight_to_change = abs(weight_diff)
            rate_for_goal = abs(actual_rate) if actual_rate else 0
            if rate_for_goal > 0 and rate_for_goal < 10 and weight_to_change > 0:
                weeks_to_goal = weight_to_change / rate_for_goal
                if weeks_to_goal < 52:
                    msg += f"🎯 До цели: ~{weeks_to_goal:.0f} нед.\n"
                else:
                    months = weeks_to_goal / 4.3
                    msg += f"🎯 До цели: ~{months:.0f} мес.\n"

            if days_tracked < 7:
                msg += f"_({days_tracked} дн. данных — точность повысится)_\n"
        else:
            msg += f"⏱ Цель темпа: {rate_names.get(profile.get('weight_loss_rate'), profile.get('weight_loss_rate'))}\n"

    return msg


def format_weight_history(data: dict) -> str:
    """Format weight history as a message."""
    if "error" in data:
        return f"❌ Ошибка: {data['error']}"

    history = data.get("history", [])
    target = data.get("target_weight")
    current = data.get("current_weight")

    if not history:
        return "📊 *История веса*\n\nНет записей. Используйте /weight чтобы записать вес."

    msg = "📊 *История веса*\n\n"

    if current and target:
        diff = current - target
        if diff > 0:
            msg += f"🎯 До цели: {diff:.1f} кг\n\n"
        else:
            msg += f"🎉 Цель достигнута! ({target} кг)\n\n"

    # Show last 10 records
    for record in history[:10]:
        weight = record.get("weight", 0)
        date = record.get("recorded_at", "")[:10]
        msg += f"• {date}: {weight} кг\n"

    if len(history) > 10:
        msg += f"\n_...и ещё {len(history) - 10} записей_"

    return msg
