-- Migration: Add goal_type to user_profiles
-- Date: 2025-01-10

-- Add goal_type column to user_profiles
-- Values: 'lose_weight' (deficit), 'gain_weight' (surplus), 'maintain' (TDEE)
ALTER TABLE user_profiles ADD COLUMN goal_type TEXT DEFAULT 'lose_weight' CHECK(goal_type IN ('lose_weight', 'gain_weight', 'maintain'));
