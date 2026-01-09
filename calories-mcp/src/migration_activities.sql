-- Migration: Add activities tracking
-- Date: 2025-01-10

CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    -- Structured fields
    activity_type TEXT NOT NULL CHECK(activity_type IN ('walking', 'running', 'cycling', 'gym', 'swimming', 'yoga', 'other')),
    duration_minutes INTEGER NOT NULL,
    intensity TEXT DEFAULT 'moderate' CHECK(intensity IN ('light', 'moderate', 'vigorous')),
    calories_burned INTEGER,

    -- Free text for AI analysis
    description TEXT,
    notes TEXT
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_activities_user_id ON activities(user_id);
CREATE INDEX IF NOT EXISTS idx_activities_created_at ON activities(created_at);
CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(date(created_at));
