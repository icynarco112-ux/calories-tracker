-- Calories Tracker Database Schema for Cloudflare D1

CREATE TABLE IF NOT EXISTS meals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    meal_name TEXT NOT NULL,
    calories INTEGER NOT NULL,
    proteins REAL DEFAULT 0,
    fats REAL DEFAULT 0,
    carbs REAL DEFAULT 0,
    fiber REAL DEFAULT 0,
    water_ml INTEGER DEFAULT 0,
    meal_type TEXT DEFAULT 'other',
    healthiness_score INTEGER DEFAULT 5,
    notes TEXT
);

-- Index for faster date queries
CREATE INDEX IF NOT EXISTS idx_meals_created_at ON meals(created_at);
CREATE INDEX IF NOT EXISTS idx_meals_date ON meals(date(created_at));
