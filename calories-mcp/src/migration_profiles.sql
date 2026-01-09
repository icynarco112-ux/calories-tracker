-- Migration: Add user profiles and weight tracking

-- Create user_profiles table
CREATE TABLE IF NOT EXISTS user_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL REFERENCES users(id),

    -- Physical parameters
    height_cm INTEGER,
    current_weight REAL,
    target_weight REAL,
    birth_date DATE,
    gender TEXT CHECK(gender IN ('male', 'female')),
    activity_level TEXT CHECK(activity_level IN ('sedentary', 'light', 'moderate', 'active', 'very_active')),

    -- Calculated goals
    bmr INTEGER,
    tdee INTEGER,
    daily_calorie_goal INTEGER,
    protein_goal INTEGER,

    -- Settings
    weight_loss_rate TEXT DEFAULT 'moderate' CHECK(weight_loss_rate IN ('slow', 'moderate', 'fast')),

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create weight_history table
CREATE TABLE IF NOT EXISTS weight_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    weight REAL NOT NULL,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    notes TEXT
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON user_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_weight_history_user_id ON weight_history(user_id);
CREATE INDEX IF NOT EXISTS idx_weight_history_date ON weight_history(recorded_at);
