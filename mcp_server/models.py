from datetime import datetime
from sqlalchemy import Column, Integer, String, Float, DateTime, Text, SmallInteger
from sqlalchemy.ext.declarative import declarative_base

Base = declarative_base()


class Meal(Base):
    __tablename__ = "meals"

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    meal_name = Column(String(255), nullable=False)
    calories = Column(Integer, nullable=False)
    proteins = Column(Float, default=0)
    fats = Column(Float, default=0)
    carbs = Column(Float, default=0)
    fiber = Column(Float, default=0)
    water_ml = Column(Integer, default=0)
    meal_type = Column(String(50), default="other")  # breakfast, lunch, dinner, snack, other
    healthiness_score = Column(SmallInteger, default=5)  # 1-10
    notes = Column(Text, nullable=True)

    def to_dict(self):
        return {
            "id": self.id,
            "created_at": self.created_at.isoformat(),
            "meal_name": self.meal_name,
            "calories": self.calories,
            "proteins": self.proteins,
            "fats": self.fats,
            "carbs": self.carbs,
            "fiber": self.fiber,
            "water_ml": self.water_ml,
            "meal_type": self.meal_type,
            "healthiness_score": self.healthiness_score,
            "notes": self.notes,
        }
