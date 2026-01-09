-- Migration: Add multi-user support

-- Create users table
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_chat_id TEXT UNIQUE NOT NULL,
    user_code TEXT UNIQUE NOT NULL,
    username TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Add user_id column to meals (if not exists)
ALTER TABLE meals ADD COLUMN user_id INTEGER REFERENCES users(id);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_meals_user_id ON meals(user_id);
CREATE INDEX IF NOT EXISTS idx_users_code ON users(user_code);
CREATE INDEX IF NOT EXISTS idx_users_telegram ON users(telegram_chat_id);
