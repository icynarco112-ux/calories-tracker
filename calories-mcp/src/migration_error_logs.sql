-- Migration: Add error_logs table for debugging MCP issues
-- Run with: wrangler d1 execute calories-tracker-db --file=src/migration_error_logs.sql

CREATE TABLE IF NOT EXISTS error_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT DEFAULT (datetime('now')),
    tool_name TEXT NOT NULL,
    error_message TEXT,
    error_stack TEXT,
    user_code TEXT,
    user_id INTEGER,
    raw_args TEXT,
    request_info TEXT
);

-- Index for quick lookup by time and user
CREATE INDEX IF NOT EXISTS idx_error_logs_timestamp ON error_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_error_logs_user ON error_logs(user_code);
