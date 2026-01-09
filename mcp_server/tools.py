from datetime import datetime, timedelta
from sqlalchemy import func
from sqlalchemy.orm import Session
from models import Meal


def add_meal(
    db: Session,
    meal_name: str,
    calories: int,
    proteins: float = 0,
    fats: float = 0,
    carbs: float = 0,
    fiber: float = 0,
    water_ml: int = 0,
    meal_type: str = "other",
    healthiness_score: int = 5,
    notes: str = None,
) -> dict:
    """Add a new meal to the database."""
    meal = Meal(
        meal_name=meal_name,
        calories=calories,
        proteins=proteins,
        fats=fats,
        carbs=carbs,
        fiber=fiber,
        water_ml=water_ml,
        meal_type=meal_type,
        healthiness_score=max(1, min(10, healthiness_score)),
        notes=notes,
    )
    db.add(meal)
    db.commit()
    db.refresh(meal)
    return {
        "success": True,
        "message": f"Meal '{meal_name}' added successfully",
        "meal": meal.to_dict(),
    }


def get_today_summary(db: Session) -> dict:
    """Get nutrition summary for today."""
    today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    today_end = today_start + timedelta(days=1)

    meals = db.query(Meal).filter(
        Meal.created_at >= today_start,
        Meal.created_at < today_end
    ).all()

    if not meals:
        return {
            "date": today_start.strftime("%Y-%m-%d"),
            "total_meals": 0,
            "total_calories": 0,
            "total_proteins": 0,
            "total_fats": 0,
            "total_carbs": 0,
            "total_fiber": 0,
            "total_water_ml": 0,
            "avg_healthiness": 0,
            "meals": [],
        }

    total_calories = sum(m.calories for m in meals)
    total_proteins = sum(m.proteins for m in meals)
    total_fats = sum(m.fats for m in meals)
    total_carbs = sum(m.carbs for m in meals)
    total_fiber = sum(m.fiber for m in meals)
    total_water = sum(m.water_ml for m in meals)
    avg_health = sum(m.healthiness_score for m in meals) / len(meals)

    return {
        "date": today_start.strftime("%Y-%m-%d"),
        "total_meals": len(meals),
        "total_calories": total_calories,
        "total_proteins": round(total_proteins, 1),
        "total_fats": round(total_fats, 1),
        "total_carbs": round(total_carbs, 1),
        "total_fiber": round(total_fiber, 1),
        "total_water_ml": total_water,
        "avg_healthiness": round(avg_health, 1),
        "meals": [m.to_dict() for m in meals],
    }


def get_weekly_summary(db: Session) -> dict:
    """Get nutrition summary for the last 7 days."""
    today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today - timedelta(days=6)

    meals = db.query(Meal).filter(
        Meal.created_at >= week_start,
        Meal.created_at < today + timedelta(days=1)
    ).all()

    # Group by day
    daily_stats = {}
    for i in range(7):
        day = week_start + timedelta(days=i)
        day_str = day.strftime("%Y-%m-%d")
        daily_stats[day_str] = {
            "calories": 0,
            "proteins": 0,
            "fats": 0,
            "carbs": 0,
            "meals_count": 0,
            "avg_healthiness": 0,
        }

    for meal in meals:
        day_str = meal.created_at.strftime("%Y-%m-%d")
        if day_str in daily_stats:
            daily_stats[day_str]["calories"] += meal.calories
            daily_stats[day_str]["proteins"] += meal.proteins
            daily_stats[day_str]["fats"] += meal.fats
            daily_stats[day_str]["carbs"] += meal.carbs
            daily_stats[day_str]["meals_count"] += 1
            daily_stats[day_str]["avg_healthiness"] += meal.healthiness_score

    # Calculate averages
    for day_str in daily_stats:
        count = daily_stats[day_str]["meals_count"]
        if count > 0:
            daily_stats[day_str]["avg_healthiness"] = round(
                daily_stats[day_str]["avg_healthiness"] / count, 1
            )

    total_calories = sum(d["calories"] for d in daily_stats.values())
    total_meals = sum(d["meals_count"] for d in daily_stats.values())

    return {
        "period": f"{week_start.strftime('%Y-%m-%d')} - {today.strftime('%Y-%m-%d')}",
        "total_meals": total_meals,
        "total_calories": total_calories,
        "avg_daily_calories": round(total_calories / 7, 0),
        "daily_breakdown": daily_stats,
    }


def get_monthly_summary(db: Session) -> dict:
    """Get nutrition summary for the current month."""
    today = datetime.utcnow()
    month_start = today.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    meals = db.query(Meal).filter(
        Meal.created_at >= month_start,
        Meal.created_at < today + timedelta(days=1)
    ).all()

    if not meals:
        return {
            "month": today.strftime("%Y-%m"),
            "total_meals": 0,
            "total_calories": 0,
            "avg_daily_calories": 0,
            "avg_healthiness": 0,
            "meal_types": {},
        }

    total_calories = sum(m.calories for m in meals)
    total_proteins = sum(m.proteins for m in meals)
    total_fats = sum(m.fats for m in meals)
    total_carbs = sum(m.carbs for m in meals)
    avg_health = sum(m.healthiness_score for m in meals) / len(meals)

    # Count by meal type
    meal_types = {}
    for meal in meals:
        meal_types[meal.meal_type] = meal_types.get(meal.meal_type, 0) + 1

    days_elapsed = (today - month_start).days + 1

    return {
        "month": today.strftime("%Y-%m"),
        "days_tracked": days_elapsed,
        "total_meals": len(meals),
        "total_calories": total_calories,
        "total_proteins": round(total_proteins, 1),
        "total_fats": round(total_fats, 1),
        "total_carbs": round(total_carbs, 1),
        "avg_daily_calories": round(total_calories / days_elapsed, 0),
        "avg_healthiness": round(avg_health, 1),
        "meal_types": meal_types,
    }


def get_meal_history(db: Session, limit: int = 10) -> dict:
    """Get recent meal history."""
    meals = db.query(Meal).order_by(Meal.created_at.desc()).limit(limit).all()
    return {
        "count": len(meals),
        "meals": [m.to_dict() for m in meals],
    }
