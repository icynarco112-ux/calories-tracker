import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Environment types
export interface Env {
  DB: D1Database;
  MCP_OBJECT: DurableObjectNamespace;
  OPENAI_API_KEY: string;
}

// Helper to get user_id from user_code
async function getUserIdByCode(db: D1Database, userCode: string): Promise<number | null> {
  const user = await db.prepare(
    "SELECT id FROM users WHERE user_code = ?"
  ).bind(userCode).first();
  return user?.id as number || null;
}

// Helper to get user_id from telegram_id
async function getUserIdByTelegram(db: D1Database, telegramId: string): Promise<number | null> {
  const user = await db.prepare(
    "SELECT id FROM users WHERE telegram_chat_id = ?"
  ).bind(telegramId).first();
  return user?.id as number || null;
}

// Calculate age from birth date
function calculateAge(birthDate: string): number {
  const birth = new Date(birthDate);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--;
  }
  return age;
}

// Calculate BMR using Mifflin-St Jeor formula
function calculateBMR(weight: number, heightCm: number, age: number, gender: string): number {
  if (gender === 'male') {
    return Math.round(10 * weight + 6.25 * heightCm - 5 * age + 5);
  } else {
    return Math.round(10 * weight + 6.25 * heightCm - 5 * age - 161);
  }
}

// Activity level multipliers
const activityMultipliers: Record<string, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

// Calculate TDEE
function calculateTDEE(bmr: number, activityLevel: string): number {
  const multiplier = activityMultipliers[activityLevel] || 1.2;
  return Math.round(bmr * multiplier);
}

// Weight change rate adjustments (calories per day)
const changeRates: Record<string, number> = {
  slow: 275,      // 0.25 kg/week
  moderate: 550,  // 0.5 kg/week
  fast: 825,      // 0.75 kg/week
};

// Calculate daily calorie goal based on goal_type
function calculateDailyGoal(tdee: number, weightChangeRate: string, goalType: string = 'lose_weight'): number {
  const adjustment = changeRates[weightChangeRate] || 550;

  switch (goalType) {
    case 'lose_weight':
      return Math.max(1200, tdee - adjustment); // Minimum 1200 kcal for safety
    case 'gain_weight':
      return tdee + adjustment;
    case 'maintain':
    default:
      return tdee;
  }
}

// MET values for calorie calculation (by activity type and intensity)
const metValues: Record<string, Record<string, number>> = {
  walking: { light: 2.5, moderate: 3.5, vigorous: 5.0 },
  running: { light: 6.0, moderate: 8.0, vigorous: 11.0 },
  cycling: { light: 4.0, moderate: 6.0, vigorous: 10.0 },
  gym: { light: 3.0, moderate: 5.0, vigorous: 8.0 },
  swimming: { light: 4.0, moderate: 6.0, vigorous: 9.0 },
  yoga: { light: 2.0, moderate: 3.0, vigorous: 4.0 },
  other: { light: 3.0, moderate: 5.0, vigorous: 7.0 },
};

// Calculate protein goal (1.6g per kg of target weight)
function calculateProteinGoal(targetWeight: number): number {
  return Math.round(targetWeight * 1.6);
}

// ============ AI ANALYTICS ============

// AI Prompts
const DAILY_ANALYSIS_PROMPT = `Ты — диетолог-коуч. Проанализируй питание пользователя за день.

ВАЖНЫЕ ПРАВИЛА:
1. НЕ повторяй замечания из вчерашнего анализа (если он предоставлен)
2. НЕ критикуй за дефицит/профицит калорий — пользователь видит цифры сам
3. Учитывай ЦЕЛЬ пользователя (похудение/набор/поддержание) и адаптируй тон
4. Будь позитивным и мотивирующим, давай полезные советы
5. Избегай банальностей типа "пейте больше воды"

Формат ответа:
1. Краткая оценка дня (1 предложение, позитивное)
2. Что получилось хорошо (конкретно)
3. Один практичный совет на завтра (не критика!)

Отвечай на русском, кратко (до 100 слов). Используй эмодзи умеренно.`;

const TIPS_PROMPT = `Ты — персональный диетолог-коуч. На основе истории питания пользователя за неделю дай 3 персональных совета.
Учитывай паттерны: когда переедает, чего не хватает, что можно улучшить.
Формат:
1. [Совет]
2. [Совет]
3. [Совет]
Отвечай на русском, конкретно и мотивирующе. До 150 слов.`;

const PREDICT_PROMPT = `Ты — эксперт по снижению веса.

Я предоставлю тебе ГОТОВЫЕ РАСЧЁТЫ прогноза веса (формула: 7700 ккал = 1 кг).
Твоя задача:
1. Подтвердить прогноз (он уже рассчитан математически)
2. Оценить реалистичность темпа (безопасно: 0.5-1 кг/нед)
3. Указать на проблемы если есть (мало белка, нестабильность, слишком быстро/медленно)
4. Дать 1 конкретную рекомендацию

Отвечай на русском, кратко (до 100 слов). Не пересчитывай — цифры уже верные.`;

const WEEKLY_ANALYSIS_PROMPT = `Ты — диетолог-аналитик. Проанализируй питание пользователя за неделю.

ФОКУС АНАЛИЗА:
1. Стабильность питания (разброс калорий по дням)
2. Тренды (улучшение/ухудшение)
3. Проблемные дни (пропуски, переедание, недоедание)
4. Баланс макронутриентов
5. Прогресс к цели

ФОРМАТ:
📊 *Тренд недели:* [одно предложение]
✅ *Что хорошо:* [конкретное достижение]
⚠️ *Зона внимания:* [что улучшить]
💡 *На следующую неделю:* [один конкретный совет]

ПРАВИЛА:
- Анализируй ПАТТЕРНЫ, не отдельные дни
- Учитывай цель (похудение/набор/поддержание)
- Если мало данных — скажи об этом
- До 100 слов, кратко`;

const MONTHLY_ANALYSIS_PROMPT = `Ты — диетолог-коуч. Подведи итоги месяца по питанию.

ФОКУС АНАЛИЗА:
1. Общий прогресс к цели (вес, привычки)
2. Средние показатели vs норма
3. Регулярность отслеживания (дисциплина)
4. Главные достижения и вызовы

ФОРМАТ:
🏆 *Итог месяца:* [главное достижение или вызов]
📈 *Статистика:* [ключевые цифры]
🎯 *Стратегия:* [совет на следующий месяц]

ПРАВИЛА:
- Это ИТОГОВЫЙ анализ — будь позитивным но честным
- Фокус на привычках, не на отдельных днях
- Если мало дней отслеживания — отметь это
- До 100 слов`;

// Call OpenAI API
async function callOpenAI(
  apiKey: string,
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage }
        ],
        max_tokens: 500,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0].message.content;
  } catch (error) {
    console.error("OpenAI API error:", error);
    throw error;
  }
}

// Get cached insight or null
async function getCachedInsight(
  db: D1Database,
  userId: number,
  insightType: string
): Promise<string | null> {
  const cached = await db.prepare(
    `SELECT content FROM ai_insights
     WHERE user_id = ? AND insight_type = ? AND insight_date = date('now', '+2 hours')
     LIMIT 1`
  ).bind(userId, insightType).first();
  return cached?.content as string || null;
}

// Save insight to cache
async function saveInsight(
  db: D1Database,
  userId: number,
  insightType: string,
  content: string
): Promise<void> {
  await db.prepare(
    `INSERT OR REPLACE INTO ai_insights (user_id, insight_type, insight_date, content)
     VALUES (?, ?, date('now', '+2 hours'), ?)`
  ).bind(userId, insightType, content).run();
}

// Invalidate cached insight when data changes
async function invalidateDailyInsight(
  db: D1Database,
  userId: number
): Promise<void> {
  await db.prepare(
    `DELETE FROM ai_insights
     WHERE user_id = ? AND insight_type = 'daily' AND insight_date = date('now', '+2 hours')`
  ).bind(userId).run();
}

// MCP Server with Calories Tracker tools (multi-user support)
export class CaloriesMCP extends McpAgent<Env, unknown, unknown> {
  server = new McpServer({
    name: "calories-tracker",
    version: "2.0.0",
  });

  // Helper to get userId - checks props first, then storage
  private async getUserId(): Promise<number | null> {
    // 1. Try to get from props (passed from fetch handler)
    const props = this.props as { userCode?: string } | undefined;
    let userCode = props?.userCode || null;

    // 2. If not in props, try storage (for subsequent tool calls)
    if (!userCode) {
      userCode = await this.ctx.storage.get("userCode") as string | null;
    }

    // 3. If we have a code, save to storage for future calls
    if (userCode) {
      await this.ctx.storage.put("userCode", userCode);
    }

    if (!userCode) {
      return null;
    }

    return await getUserIdByCode(this.env.DB, userCode);
  }

  async init() {
    // Store user code from props (passed from fetch handler via ctx.props)
    const props = this.props as { userCode?: string } | undefined;
    if (props?.userCode) {
      await this.ctx.storage.put("userCode", props.userCode);
    }

    // Tool: add_meal
    this.server.tool(
      "add_meal",
      "Add a new meal to the calories tracker. Use this when the user sends food photos or describes what they ate.",
      {
        meal_name: z.string().describe("Name of the meal or dish"),
        calories: z.number().describe("Estimated calories (kcal)"),
        proteins: z.number().optional().describe("Protein content in grams"),
        fats: z.number().optional().describe("Fat content in grams"),
        carbs: z.number().optional().describe("Carbohydrate content in grams"),
        fiber: z.number().optional().describe("Fiber content in grams"),
        water_ml: z.number().optional().describe("Water content in milliliters"),
        meal_type: z
          .enum(["breakfast", "lunch", "dinner", "snack", "other"])
          .optional()
          .describe("Type of meal"),
        healthiness_score: z
          .number()
          .min(1)
          .max(10)
          .optional()
          .describe("Health score from 1 (unhealthy) to 10 (very healthy)"),
        notes: z.string().optional().describe("Additional notes about the meal"),
      },
      async (args) => {
        const userId = await this.getUserId();
        if (!userId) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "User not authenticated. Please register via Telegram bot." }) }],
          };
        }

        // Check for duplicate meal (same name and similar calories within last 3 minutes)
        const recentDuplicate = await this.env.DB.prepare(
          `SELECT id FROM meals
           WHERE user_id = ?
           AND meal_name = ?
           AND calories BETWEEN ? AND ?
           AND created_at > datetime('now', '-3 minutes')
           LIMIT 1`
        ).bind(
          userId,
          args.meal_name,
          Math.floor(args.calories * 0.9),
          Math.ceil(args.calories * 1.1)
        ).first();

        if (recentDuplicate) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                message: `Meal "${args.meal_name}" already recorded recently`,
                duplicate: true,
                existing_id: recentDuplicate.id,
                calories: args.calories,
              }),
            }],
          };
        }

        const result = await this.env.DB.prepare(
          `INSERT INTO meals (user_id, meal_name, calories, proteins, fats, carbs, fiber, water_ml, meal_type, healthiness_score, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            userId,
            args.meal_name,
            args.calories,
            args.proteins ?? 0,
            args.fats ?? 0,
            args.carbs ?? 0,
            args.fiber ?? 0,
            args.water_ml ?? 0,
            args.meal_type ?? "other",
            args.healthiness_score ?? 5,
            args.notes ?? null
          )
          .run();

        // Invalidate daily AI analysis cache so next analysis is fresh
        await invalidateDailyInsight(this.env.DB, userId);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                message: `Meal "${args.meal_name}" added successfully!`,
                calories: args.calories,
                id: result.meta.last_row_id,
              }),
            },
          ],
        };
      }
    );

    // Tool: add_water
    this.server.tool(
      "add_water",
      "Record water intake. Use this when the user says they drank water, tea, coffee, or any beverage.",
      {
        amount_ml: z.number().describe("Amount of water/beverage in milliliters"),
        beverage_type: z
          .enum(["water", "tea", "coffee", "juice", "other"])
          .optional()
          .describe("Type of beverage (default: water)"),
        notes: z.string().optional().describe("Additional notes"),
      },
      async (args) => {
        const userId = await this.getUserId();
        if (!userId) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "User not authenticated" }) }],
          };
        }

        const beverageType = args.beverage_type ?? "water";
        const beverageNames: Record<string, string> = {
          water: "Вода",
          tea: "Чай",
          coffee: "Кофе",
          juice: "Сок",
          other: "Напиток",
        };

        const result = await this.env.DB.prepare(
          `INSERT INTO meals (user_id, meal_name, calories, proteins, fats, carbs, fiber, water_ml, meal_type, healthiness_score, notes)
           VALUES (?, ?, ?, 0, 0, 0, 0, ?, 'other', ?, ?)`
        )
          .bind(
            userId,
            `${beverageNames[beverageType]} ${args.amount_ml}мл`,
            beverageType === "juice" ? Math.round(args.amount_ml * 0.4) : 0,
            args.amount_ml,
            beverageType === "water" ? 10 : 8,
            args.notes ?? null
          )
          .run();

        // Invalidate daily AI analysis cache
        await invalidateDailyInsight(this.env.DB, userId);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                message: `Recorded ${args.amount_ml}ml of ${beverageType}`,
                amount_ml: args.amount_ml,
                id: result.meta.last_row_id,
              }),
            },
          ],
        };
      }
    );

    // Tool: add_activity
    this.server.tool(
      "add_activity",
      "Record physical activity or exercise. Use this when the user describes workout, walking, running, or any physical activity.",
      {
        activity_type: z
          .enum(["walking", "running", "cycling", "gym", "swimming", "yoga", "other"])
          .describe("Type of activity: walking, running, cycling, gym, swimming, yoga, other"),
        duration_minutes: z
          .number()
          .min(1)
          .max(600)
          .describe("Duration of activity in minutes"),
        intensity: z
          .enum(["light", "moderate", "vigorous"])
          .optional()
          .describe("Intensity level: light, moderate (default), vigorous"),
        calories_burned: z
          .number()
          .optional()
          .describe("Estimated calories burned (if known, otherwise will be calculated)"),
        description: z
          .string()
          .optional()
          .describe("Free text description of the activity for AI analysis"),
        notes: z
          .string()
          .optional()
          .describe("Additional notes about the activity"),
      },
      async (args) => {
        const userId = await this.getUserId();
        if (!userId) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "User not authenticated" }) }],
          };
        }

        const intensity = args.intensity || "moderate";

        // Calculate calories if not provided
        let caloriesBurned = args.calories_burned;
        if (!caloriesBurned) {
          // Get user weight from profile for more accurate calculation
          const profile = await this.env.DB.prepare(
            "SELECT current_weight FROM user_profiles WHERE user_id = ?"
          ).bind(userId).first();
          const weight = (profile?.current_weight as number) || 70; // Default 70kg

          const met = metValues[args.activity_type]?.[intensity] || 5.0;
          // Calories = MET × weight (kg) × duration (hours)
          caloriesBurned = Math.round((met * weight * args.duration_minutes) / 60);
        }

        const result = await this.env.DB.prepare(
          `INSERT INTO activities (user_id, activity_type, duration_minutes, intensity, calories_burned, description, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          userId,
          args.activity_type,
          args.duration_minutes,
          intensity,
          caloriesBurned,
          args.description || null,
          args.notes || null
        ).run();

        // Invalidate daily AI analysis cache
        await invalidateDailyInsight(this.env.DB, userId);

        const activityNames: Record<string, string> = {
          walking: "Ходьба",
          running: "Бег",
          cycling: "Велосипед",
          gym: "Тренажёрный зал",
          swimming: "Плавание",
          yoga: "Йога",
          other: "Активность",
        };

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              message: `${activityNames[args.activity_type]} записана: ${args.duration_minutes} мин, ${caloriesBurned} ккал сожжено`,
              activity_type: args.activity_type,
              duration_minutes: args.duration_minutes,
              intensity,
              calories_burned: caloriesBurned,
              id: result.meta.last_row_id,
            }),
          }],
        };
      }
    );

    // Tool: get_today_summary
    this.server.tool(
      "get_today_summary",
      "Get nutrition summary for today including total calories, macros, and all meals.",
      {},
      async () => {
        const userId = await this.getUserId();
        if (!userId) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "User not authenticated" }) }],
          };
        }

        const summary = await this.env.DB.prepare(
          `SELECT
            COUNT(*) as meal_count,
            COALESCE(SUM(calories), 0) as total_calories,
            COALESCE(SUM(proteins), 0) as total_proteins,
            COALESCE(SUM(fats), 0) as total_fats,
            COALESCE(SUM(carbs), 0) as total_carbs,
            COALESCE(SUM(fiber), 0) as total_fiber,
            COALESCE(SUM(water_ml), 0) as total_water,
            COALESCE(AVG(healthiness_score), 0) as avg_healthiness
           FROM meals
           WHERE user_id = ? AND date(created_at, '+2 hours') = date('now', '+2 hours')`
        ).bind(userId).first();

        const meals = await this.env.DB.prepare(
          `SELECT id, meal_name, calories, proteins, fats, carbs, meal_type, healthiness_score,
                  strftime('%H:%M', created_at, '+2 hours') as time
           FROM meals
           WHERE user_id = ? AND date(created_at, '+2 hours') = date('now', '+2 hours')
           ORDER BY created_at DESC`
        ).bind(userId).all();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  date: new Date().toISOString().split("T")[0],
                  summary,
                  meals: meals.results,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    // Tool: get_weekly_summary
    this.server.tool(
      "get_weekly_summary",
      "Get nutrition summary for the last 7 days with daily breakdown.",
      {},
      async () => {
        const userId = await this.getUserId();
        if (!userId) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "User not authenticated" }) }],
          };
        }

        const dailyStats = await this.env.DB.prepare(
          `SELECT
            date(created_at, '+2 hours') as date,
            COUNT(*) as meal_count,
            SUM(calories) as total_calories,
            SUM(proteins) as total_proteins,
            SUM(fats) as total_fats,
            SUM(carbs) as total_carbs,
            AVG(healthiness_score) as avg_healthiness
           FROM meals
           WHERE user_id = ? AND date(created_at, '+2 hours') >= date('now', '+2 hours', '-7 days')
           GROUP BY date(created_at, '+2 hours')
           ORDER BY date DESC`
        ).bind(userId).all();

        const weekTotal = await this.env.DB.prepare(
          `SELECT
            COUNT(*) as meal_count,
            SUM(calories) as total_calories,
            AVG(calories) as avg_daily_calories,
            SUM(proteins) as total_proteins,
            SUM(fats) as total_fats,
            SUM(carbs) as total_carbs,
            AVG(healthiness_score) as avg_healthiness
           FROM meals
           WHERE user_id = ? AND date(created_at, '+2 hours') >= date('now', '+2 hours', '-7 days')`
        ).bind(userId).first();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  period: "Last 7 days",
                  total: weekTotal,
                  daily_breakdown: dailyStats.results,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    // Tool: get_monthly_summary
    this.server.tool(
      "get_monthly_summary",
      "Get nutrition summary for the current month.",
      {},
      async () => {
        const userId = await this.getUserId();
        if (!userId) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "User not authenticated" }) }],
          };
        }

        const monthStats = await this.env.DB.prepare(
          `SELECT
            COUNT(*) as meal_count,
            SUM(calories) as total_calories,
            AVG(calories) as avg_calories_per_meal,
            SUM(proteins) as total_proteins,
            SUM(fats) as total_fats,
            SUM(carbs) as total_carbs,
            SUM(fiber) as total_fiber,
            AVG(healthiness_score) as avg_healthiness,
            COUNT(DISTINCT date(created_at, '+2 hours')) as days_tracked
           FROM meals
           WHERE user_id = ? AND strftime('%Y-%m', created_at, '+2 hours') = strftime('%Y-%m', 'now', '+2 hours')`
        ).bind(userId).first();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  period: new Date().toISOString().slice(0, 7),
                  summary: monthStats,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    // Tool: get_meal_history
    this.server.tool(
      "get_meal_history",
      "Get recent meal history.",
      {
        limit: z
          .number()
          .optional()
          .describe("Number of meals to return (default: 10)"),
      },
      async (args) => {
        const userId = await this.getUserId();
        if (!userId) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "User not authenticated" }) }],
          };
        }

        const limit = args.limit ?? 10;
        const meals = await this.env.DB.prepare(
          `SELECT id, meal_name, calories, proteins, fats, carbs, fiber, water_ml,
                  meal_type, healthiness_score, notes, created_at
           FROM meals
           WHERE user_id = ?
           ORDER BY created_at DESC
           LIMIT ?`
        )
          .bind(userId, limit)
          .all();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  count: meals.results.length,
                  meals: meals.results,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    // Tool: set_user_profile
    this.server.tool(
      "set_user_profile",
      "Set or update user profile with physical parameters and goals. This calculates BMR, TDEE, and daily calorie targets automatically.",
      {
        height_cm: z.number().min(100).max(250).describe("Height in centimeters"),
        current_weight: z.number().min(30).max(300).describe("Current weight in kg"),
        target_weight: z.number().min(30).max(300).describe("Target weight in kg"),
        birth_date: z.string().describe("Birth date in YYYY-MM-DD format"),
        gender: z.enum(["male", "female"]).describe("Gender for BMR calculation"),
        activity_level: z
          .enum(["sedentary", "light", "moderate", "active", "very_active"])
          .describe("Activity level: sedentary (office), light (1-2 workouts/week), moderate (3-5), active (6-7), very_active (athletes)"),
        goal_type: z
          .enum(["lose_weight", "gain_weight", "maintain"])
          .optional()
          .describe("User goal: lose_weight (calorie deficit), gain_weight (calorie surplus), maintain (TDEE)"),
        weight_change_rate: z
          .enum(["slow", "moderate", "fast"])
          .optional()
          .describe("Weight change rate: slow (0.25kg/week), moderate (0.5kg/week), fast (0.75kg/week)"),
      },
      async (args) => {
        const userId = await this.getUserId();
        if (!userId) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "User not authenticated" }) }],
          };
        }

        const age = calculateAge(args.birth_date);
        const bmr = calculateBMR(args.current_weight, args.height_cm, age, args.gender);
        const tdee = calculateTDEE(bmr, args.activity_level);
        const goalType = args.goal_type ?? "lose_weight";
        const weightChangeRate = args.weight_change_rate ?? "moderate";
        const dailyGoal = calculateDailyGoal(tdee, weightChangeRate, goalType);
        const proteinGoal = calculateProteinGoal(args.target_weight);

        // Upsert profile
        await this.env.DB.prepare(
          `INSERT INTO user_profiles (user_id, height_cm, current_weight, target_weight, birth_date, gender, activity_level, bmr, tdee, daily_calorie_goal, protein_goal, weight_loss_rate, goal_type, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(user_id) DO UPDATE SET
             height_cm = excluded.height_cm,
             current_weight = excluded.current_weight,
             target_weight = excluded.target_weight,
             birth_date = excluded.birth_date,
             gender = excluded.gender,
             activity_level = excluded.activity_level,
             bmr = excluded.bmr,
             tdee = excluded.tdee,
             daily_calorie_goal = excluded.daily_calorie_goal,
             protein_goal = excluded.protein_goal,
             weight_loss_rate = excluded.weight_loss_rate,
             goal_type = excluded.goal_type,
             updated_at = datetime('now')`
        )
          .bind(
            userId,
            args.height_cm,
            args.current_weight,
            args.target_weight,
            args.birth_date,
            args.gender,
            args.activity_level,
            bmr,
            tdee,
            dailyGoal,
            proteinGoal,
            weightChangeRate,
            goalType
          )
          .run();

        // Also log initial weight
        await this.env.DB.prepare(
          `INSERT INTO weight_history (user_id, weight) VALUES (?, ?)`
        ).bind(userId, args.current_weight).run();

        const weightToChange = Math.abs(args.current_weight - args.target_weight);
        const weeklyRate = weightChangeRate === 'slow' ? 0.25 : weightChangeRate === 'fast' ? 0.75 : 0.5;
        const weeksToGoal = goalType === 'maintain' ? null : Math.round(weightToChange / weeklyRate);

        const goalTypeNames: Record<string, string> = {
          lose_weight: "Похудение",
          gain_weight: "Набор массы",
          maintain: "Поддержание веса",
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                message: "Profile saved successfully!",
                profile: {
                  height_cm: args.height_cm,
                  current_weight: args.current_weight,
                  target_weight: args.target_weight,
                  age,
                  gender: args.gender,
                  activity_level: args.activity_level,
                  goal_type: goalType,
                  goal_type_display: goalTypeNames[goalType],
                },
                calculations: {
                  bmr,
                  tdee,
                  daily_calorie_goal: dailyGoal,
                  protein_goal: proteinGoal,
                  weight_change_rate: weightChangeRate,
                  weight_to_change: weightToChange,
                  estimated_weeks: weeksToGoal,
                },
              }, null, 2),
            },
          ],
        };
      }
    );

    // Tool: get_user_profile
    this.server.tool(
      "get_user_profile",
      "Get user's profile with physical parameters, goals, and calculated targets.",
      {},
      async () => {
        const userId = await this.getUserId();
        if (!userId) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "User not authenticated" }) }],
          };
        }

        const profile = await this.env.DB.prepare(
          `SELECT * FROM user_profiles WHERE user_id = ?`
        ).bind(userId).first();

        if (!profile) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "Profile not found",
                  message: "User has not set up their profile yet. Use set_user_profile to create one.",
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ profile }, null, 2),
            },
          ],
        };
      }
    );

    // Tool: log_weight
    this.server.tool(
      "log_weight",
      "Record current weight. Use this when user reports their weight for tracking progress.",
      {
        weight: z.number().min(30).max(300).describe("Current weight in kg"),
        notes: z.string().optional().describe("Optional notes about the weight measurement"),
      },
      async (args) => {
        const userId = await this.getUserId();
        if (!userId) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "User not authenticated" }) }],
          };
        }

        // Insert weight record
        await this.env.DB.prepare(
          `INSERT INTO weight_history (user_id, weight, notes) VALUES (?, ?, ?)`
        ).bind(userId, args.weight, args.notes ?? null).run();

        // Update current weight in profile
        await this.env.DB.prepare(
          `UPDATE user_profiles SET current_weight = ?, updated_at = datetime('now') WHERE user_id = ?`
        ).bind(args.weight, userId).run();

        // Get previous weight for comparison
        const previousWeight = await this.env.DB.prepare(
          `SELECT weight FROM weight_history WHERE user_id = ? ORDER BY recorded_at DESC LIMIT 1 OFFSET 1`
        ).bind(userId).first();

        const change = previousWeight ? args.weight - (previousWeight.weight as number) : 0;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                weight: args.weight,
                change: change !== 0 ? change : null,
                change_text: change < 0 ? `${change.toFixed(1)} kg (lost)` :
                            change > 0 ? `+${change.toFixed(1)} kg (gained)` : null,
              }),
            },
          ],
        };
      }
    );

    // Tool: get_weight_history
    this.server.tool(
      "get_weight_history",
      "Get weight history for tracking progress over time.",
      {
        limit: z.number().optional().describe("Number of records to return (default: 30)"),
      },
      async (args) => {
        const userId = await this.getUserId();
        if (!userId) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "User not authenticated" }) }],
          };
        }

        const limit = args.limit ?? 30;
        const history = await this.env.DB.prepare(
          `SELECT weight, notes, datetime(recorded_at, '+2 hours') as recorded_at
           FROM weight_history
           WHERE user_id = ?
           ORDER BY recorded_at DESC
           LIMIT ?`
        ).bind(userId, limit).all();

        // Get profile for target
        const profile = await this.env.DB.prepare(
          `SELECT target_weight, current_weight FROM user_profiles WHERE user_id = ?`
        ).bind(userId).first();

        const weights = history.results.map(r => r.weight as number);
        const minWeight = weights.length > 0 ? Math.min(...weights) : null;
        const maxWeight = weights.length > 0 ? Math.max(...weights) : null;
        const totalChange = weights.length >= 2 ? weights[0] - weights[weights.length - 1] : 0;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                history: history.results,
                stats: {
                  records_count: history.results.length,
                  current_weight: profile?.current_weight,
                  target_weight: profile?.target_weight,
                  min_weight: minWeight,
                  max_weight: maxWeight,
                  total_change: totalChange,
                },
              }, null, 2),
            },
          ],
        };
      }
    );
  }
}

// JSON response helper
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// Simple fetch handler
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    // Health check
    if (url.pathname === "/health") {
      return jsonResponse({ status: "ok" });
    }

    // Root - info
    if (url.pathname === "/") {
      return jsonResponse({
        name: "Calories Tracker MCP Server",
        version: "2.0.0",
        mcp_endpoint: "/sse?code=YOUR_CODE",
        api_endpoints: ["/api/register", "/api/user", "/api/today", "/api/week", "/api/month"],
      });
    }

    // === User Registration API ===

    // POST /api/register - register new user
    if (url.pathname === "/api/register" && request.method === "POST") {
      try {
        const { telegram_id, username, user_code } = await request.json() as {
          telegram_id: string;
          username?: string;
          user_code: string;
        };

        await env.DB.prepare(
          "INSERT INTO users (telegram_chat_id, username, user_code) VALUES (?, ?, ?)"
        ).bind(telegram_id, username || null, user_code).run();

        return jsonResponse({ success: true, user_code });
      } catch (e: unknown) {
        const error = e as Error;
        return jsonResponse({ error: error.message }, 400);
      }
    }

    // GET /api/user - get user by telegram_id
    if (url.pathname === "/api/user") {
      const telegramId = url.searchParams.get("telegram_id");
      if (!telegramId) {
        return jsonResponse({ error: "telegram_id required" }, 400);
      }

      const user = await env.DB.prepare(
        "SELECT id, telegram_chat_id, user_code, username, created_at FROM users WHERE telegram_chat_id = ?"
      ).bind(telegramId).first();

      return jsonResponse(user || {});
    }

    // === Stats API (for Telegram bot) ===

    // GET /api/today?telegram_id=xxx
    if (url.pathname === "/api/today") {
      const telegramId = url.searchParams.get("telegram_id");
      if (!telegramId) {
        return jsonResponse({ error: "telegram_id required" }, 400);
      }

      const userId = await getUserIdByTelegram(env.DB, telegramId);
      if (!userId) {
        return jsonResponse({ error: "User not found. Use /register in Telegram bot." }, 404);
      }

      const summary = await env.DB.prepare(
        `SELECT
          COUNT(*) as meal_count,
          COALESCE(SUM(calories), 0) as total_calories,
          COALESCE(SUM(proteins), 0) as total_proteins,
          COALESCE(SUM(fats), 0) as total_fats,
          COALESCE(SUM(carbs), 0) as total_carbs,
          COALESCE(SUM(fiber), 0) as total_fiber,
          COALESCE(SUM(water_ml), 0) as total_water,
          COALESCE(AVG(healthiness_score), 0) as avg_healthiness
         FROM meals
         WHERE user_id = ? AND date(created_at, '+2 hours') = date('now', '+2 hours')`
      ).bind(userId).first();

      const meals = await env.DB.prepare(
        `SELECT id, meal_name, calories, proteins, fats, carbs, meal_type, healthiness_score,
                strftime('%H:%M', created_at, '+2 hours') as time
         FROM meals
         WHERE user_id = ? AND date(created_at, '+2 hours') = date('now', '+2 hours')
         ORDER BY created_at DESC`
      ).bind(userId).all();

      return jsonResponse({
        date: new Date().toISOString().split("T")[0],
        summary,
        meals: meals.results,
      });
    }

    // GET /api/week?telegram_id=xxx
    if (url.pathname === "/api/week") {
      const telegramId = url.searchParams.get("telegram_id");
      if (!telegramId) {
        return jsonResponse({ error: "telegram_id required" }, 400);
      }

      const userId = await getUserIdByTelegram(env.DB, telegramId);
      if (!userId) {
        return jsonResponse({ error: "User not found" }, 404);
      }

      const dailyStats = await env.DB.prepare(
        `SELECT
          date(created_at, '+2 hours') as date,
          COUNT(*) as meal_count,
          SUM(calories) as total_calories,
          SUM(proteins) as total_proteins,
          SUM(fats) as total_fats,
          SUM(carbs) as total_carbs,
          SUM(water_ml) as total_water,
          AVG(healthiness_score) as avg_healthiness
         FROM meals
         WHERE user_id = ? AND date(created_at, '+2 hours') >= date('now', '+2 hours', '-7 days')
         GROUP BY date(created_at, '+2 hours')
         ORDER BY date DESC`
      ).bind(userId).all();

      const weekTotal = await env.DB.prepare(
        `SELECT
          COUNT(*) as meal_count,
          SUM(calories) as total_calories,
          SUM(proteins) as total_proteins,
          SUM(fats) as total_fats,
          SUM(carbs) as total_carbs,
          SUM(water_ml) as total_water,
          AVG(healthiness_score) as avg_healthiness
         FROM meals
         WHERE user_id = ? AND date(created_at, '+2 hours') >= date('now', '+2 hours', '-7 days')`
      ).bind(userId).first();

      return jsonResponse({
        period: "Last 7 days",
        total: weekTotal,
        daily_breakdown: dailyStats.results,
      });
    }

    // === Profile API ===

    // GET /api/profile?telegram_id=xxx
    if (url.pathname === "/api/profile" && request.method === "GET") {
      const telegramId = url.searchParams.get("telegram_id");
      if (!telegramId) {
        return jsonResponse({ error: "telegram_id required" }, 400);
      }

      const userId = await getUserIdByTelegram(env.DB, telegramId);
      if (!userId) {
        return jsonResponse({ error: "User not found" }, 404);
      }

      const profile = await env.DB.prepare(
        `SELECT * FROM user_profiles WHERE user_id = ?`
      ).bind(userId).first() as Record<string, unknown> | null;

      if (!profile) {
        return jsonResponse({ error: "Profile not set" });
      }

      // Calculate actual rate from real meal data (last 7 days)
      const avgCalories = await env.DB.prepare(
        `SELECT AVG(daily_total) as avg_cal, COUNT(*) as days_count FROM (
          SELECT SUM(calories) as daily_total
          FROM meals
          WHERE user_id = ? AND date(created_at, '+2 hours') >= date('now', '+2 hours', '-7 days')
          GROUP BY date(created_at, '+2 hours')
        )`
      ).bind(userId).first() as { avg_cal: number | null; days_count: number } | null;

      const tdee = profile.tdee as number || 0;
      const avgCal = avgCalories?.avg_cal || 0;
      const daysTracked = avgCalories?.days_count || 0;

      // Calculate actual weekly rate (7700 kcal = 1 kg)
      let actualWeeklyRate: number | null = null;
      let actualDailyDeficit: number | null = null;

      if (daysTracked >= 1 && tdee > 0 && avgCal > 0) {
        actualDailyDeficit = tdee - avgCal;
        actualWeeklyRate = (actualDailyDeficit * 7) / 7700;
      }

      return jsonResponse({
        ...profile,
        actual_weekly_rate: actualWeeklyRate,
        actual_daily_deficit: actualDailyDeficit,
        avg_daily_calories: avgCal > 0 ? Math.round(avgCal) : null,
        days_tracked: daysTracked,
      });
    }

    // POST /api/profile - save profile
    if (url.pathname === "/api/profile" && request.method === "POST") {
      try {
        const body = await request.json() as {
          telegram_id: string;
          height_cm: number;
          current_weight: number;
          target_weight: number;
          birth_date: string;
          gender: string;
          activity_level: string;
          weight_loss_rate?: string;
        };

        const userId = await getUserIdByTelegram(env.DB, body.telegram_id);
        if (!userId) {
          return jsonResponse({ error: "User not found" }, 404);
        }

        const age = calculateAge(body.birth_date);
        const bmr = calculateBMR(body.current_weight, body.height_cm, age, body.gender);
        const tdee = calculateTDEE(bmr, body.activity_level);
        const weightLossRate = body.weight_loss_rate ?? "moderate";
        const dailyGoal = calculateDailyGoal(tdee, weightLossRate);
        const proteinGoal = calculateProteinGoal(body.target_weight);

        await env.DB.prepare(
          `INSERT INTO user_profiles (user_id, height_cm, current_weight, target_weight, birth_date, gender, activity_level, bmr, tdee, daily_calorie_goal, protein_goal, weight_loss_rate, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(user_id) DO UPDATE SET
             height_cm = excluded.height_cm,
             current_weight = excluded.current_weight,
             target_weight = excluded.target_weight,
             birth_date = excluded.birth_date,
             gender = excluded.gender,
             activity_level = excluded.activity_level,
             bmr = excluded.bmr,
             tdee = excluded.tdee,
             daily_calorie_goal = excluded.daily_calorie_goal,
             protein_goal = excluded.protein_goal,
             weight_loss_rate = excluded.weight_loss_rate,
             updated_at = datetime('now')`
        ).bind(
          userId,
          body.height_cm,
          body.current_weight,
          body.target_weight,
          body.birth_date,
          body.gender,
          body.activity_level,
          bmr,
          tdee,
          dailyGoal,
          proteinGoal,
          weightLossRate
        ).run();

        // Log initial weight
        await env.DB.prepare(
          `INSERT INTO weight_history (user_id, weight) VALUES (?, ?)`
        ).bind(userId, body.current_weight).run();

        return jsonResponse({
          success: true,
          bmr,
          tdee,
          daily_calorie_goal: dailyGoal,
          protein_goal: proteinGoal,
        });
      } catch (e: unknown) {
        const error = e as Error;
        return jsonResponse({ error: error.message }, 400);
      }
    }

    // POST /api/weight - log weight
    if (url.pathname === "/api/weight" && request.method === "POST") {
      try {
        const body = await request.json() as {
          telegram_id: string;
          weight: number;
          notes?: string;
        };

        const userId = await getUserIdByTelegram(env.DB, body.telegram_id);
        if (!userId) {
          return jsonResponse({ error: "User not found" }, 404);
        }

        await env.DB.prepare(
          `INSERT INTO weight_history (user_id, weight, notes) VALUES (?, ?, ?)`
        ).bind(userId, body.weight, body.notes ?? null).run();

        await env.DB.prepare(
          `UPDATE user_profiles SET current_weight = ?, updated_at = datetime('now') WHERE user_id = ?`
        ).bind(body.weight, userId).run();

        // Get previous weight
        const previousWeight = await env.DB.prepare(
          `SELECT weight FROM weight_history WHERE user_id = ? ORDER BY recorded_at DESC LIMIT 1 OFFSET 1`
        ).bind(userId).first();

        const change = previousWeight ? body.weight - (previousWeight.weight as number) : 0;

        return jsonResponse({
          success: true,
          weight: body.weight,
          change,
        });
      } catch (e: unknown) {
        const error = e as Error;
        return jsonResponse({ error: error.message }, 400);
      }
    }

    // GET /api/weight_history?telegram_id=xxx
    if (url.pathname === "/api/weight_history") {
      const telegramId = url.searchParams.get("telegram_id");
      if (!telegramId) {
        return jsonResponse({ error: "telegram_id required" }, 400);
      }

      const userId = await getUserIdByTelegram(env.DB, telegramId);
      if (!userId) {
        return jsonResponse({ error: "User not found" }, 404);
      }

      const history = await env.DB.prepare(
        `SELECT weight, notes, datetime(recorded_at, '+2 hours') as recorded_at
         FROM weight_history
         WHERE user_id = ?
         ORDER BY recorded_at DESC
         LIMIT 30`
      ).bind(userId).all();

      const profile = await env.DB.prepare(
        `SELECT target_weight, current_weight FROM user_profiles WHERE user_id = ?`
      ).bind(userId).first();

      return jsonResponse({
        history: history.results,
        target_weight: profile?.target_weight,
        current_weight: profile?.current_weight,
      });
    }

    // GET /api/month?telegram_id=xxx
    if (url.pathname === "/api/month") {
      const telegramId = url.searchParams.get("telegram_id");
      if (!telegramId) {
        return jsonResponse({ error: "telegram_id required" }, 400);
      }

      const userId = await getUserIdByTelegram(env.DB, telegramId);
      if (!userId) {
        return jsonResponse({ error: "User not found" }, 404);
      }

      const monthStats = await env.DB.prepare(
        `SELECT
          COUNT(*) as meal_count,
          SUM(calories) as total_calories,
          AVG(calories) as avg_calories_per_meal,
          SUM(proteins) as total_proteins,
          SUM(fats) as total_fats,
          SUM(carbs) as total_carbs,
          SUM(fiber) as total_fiber,
          SUM(water_ml) as total_water,
          AVG(healthiness_score) as avg_healthiness,
          COUNT(DISTINCT date(created_at, '+2 hours')) as days_tracked
         FROM meals
         WHERE user_id = ? AND strftime('%Y-%m', created_at, '+2 hours') = strftime('%Y-%m', 'now', '+2 hours')`
      ).bind(userId).first();

      return jsonResponse({
        period: new Date().toISOString().slice(0, 7),
        summary: monthStats,
      });
    }

    // === Activities API ===

    // GET /api/activities/today?telegram_id=xxx
    if (url.pathname === "/api/activities/today") {
      const telegramId = url.searchParams.get("telegram_id");
      if (!telegramId) {
        return jsonResponse({ error: "telegram_id required" }, 400);
      }

      const userId = await getUserIdByTelegram(env.DB, telegramId);
      if (!userId) {
        return jsonResponse({ error: "User not found" }, 404);
      }

      const activities = await env.DB.prepare(
        `SELECT id, activity_type, duration_minutes, intensity, calories_burned, description,
                strftime('%H:%M', created_at, '+2 hours') as time
         FROM activities
         WHERE user_id = ? AND date(created_at, '+2 hours') = date('now', '+2 hours')
         ORDER BY created_at DESC`
      ).bind(userId).all();

      const totals = await env.DB.prepare(
        `SELECT
          COUNT(*) as activity_count,
          COALESCE(SUM(duration_minutes), 0) as total_duration,
          COALESCE(SUM(calories_burned), 0) as total_burned
         FROM activities
         WHERE user_id = ? AND date(created_at, '+2 hours') = date('now', '+2 hours')`
      ).bind(userId).first();

      return jsonResponse({
        activities: activities.results,
        totals,
      });
    }

    // GET /api/users/all - Get all users (for broadcast)
    if (url.pathname === "/api/users/all") {
      const users = await env.DB.prepare(
        "SELECT id, telegram_chat_id, username FROM users"
      ).all();
      return jsonResponse({ users: users.results });
    }

    // === AI Analytics API ===

    // GET /api/analyze?telegram_id=xxx - AI analysis of today's meals
    if (url.pathname === "/api/analyze") {
      const telegramId = url.searchParams.get("telegram_id");
      if (!telegramId) {
        return jsonResponse({ error: "telegram_id required" }, 400);
      }

      const userId = await getUserIdByTelegram(env.DB, telegramId);
      if (!userId) {
        return jsonResponse({ error: "User not found" }, 404);
      }

      // Check cache first
      const cached = await getCachedInsight(env.DB, userId, "daily");
      if (cached) {
        return jsonResponse({ analysis: cached, cached: true });
      }

      // Get today's meals
      const todayData = await env.DB.prepare(
        `SELECT meal_name, calories, proteins, fats, carbs,
                strftime('%H:%M', created_at, '+2 hours') as time
         FROM meals
         WHERE user_id = ? AND date(created_at, '+2 hours') = date('now', '+2 hours')
         ORDER BY created_at`
      ).bind(userId).all();

      if (!todayData.results || todayData.results.length === 0) {
        return jsonResponse({
          analysis: "🤖 Сегодня ещё нет записей о еде. Добавьте приём пищи через Claude!",
          cached: false
        });
      }

      // Get user profile for context (including goal_type)
      const profile = await env.DB.prepare(
        `SELECT daily_calorie_goal, protein_goal, goal_type FROM user_profiles WHERE user_id = ?`
      ).bind(userId).first() as { daily_calorie_goal: number; protein_goal: number; goal_type: string } | null;

      // Get yesterday's insight to avoid repetition
      const yesterdayInsight = await env.DB.prepare(
        `SELECT content FROM ai_insights
         WHERE user_id = ? AND insight_type = 'daily'
         AND insight_date = date('now', '+2 hours', '-1 day')
         LIMIT 1`
      ).bind(userId).first();

      // Build context for AI
      const mealsText = todayData.results.map((m: any) =>
        `${m.time} - ${m.meal_name}: ${m.calories} ккал, Б:${m.proteins}г, Ж:${m.fats}г, У:${m.carbs}г`
      ).join("\n");

      const totalCals = todayData.results.reduce((sum: number, m: any) => sum + (m.calories || 0), 0);
      const totalProteins = todayData.results.reduce((sum: number, m: any) => sum + (m.proteins || 0), 0);

      // Goal type display names
      const goalTypeNames: Record<string, string> = {
        lose_weight: "ПОХУДЕНИЕ (дефицит калорий)",
        gain_weight: "НАБОР МАССЫ (профицит калорий)",
        maintain: "ПОДДЕРЖАНИЕ ВЕСА",
      };

      let goalInfo = profile
        ? `Цель: ${profile.daily_calorie_goal} ккал, ${profile.protein_goal}г белка.\nТип цели: ${goalTypeNames[profile.goal_type] || "не указан"}.`
        : "Профиль не настроен.";

      // Add yesterday's context if available
      if (yesterdayInsight?.content) {
        const yesterdayContent = (yesterdayInsight.content as string).substring(0, 200);
        goalInfo += `\n\nВЧЕРА ТЫ УЖЕ ГОВОРИЛ: "${yesterdayContent}..." — НЕ ПОВТОРЯЙ эти же замечания!`;
      }

      const userMessage = `Питание за сегодня:\n${mealsText}\n\nИтого: ${totalCals} ккал, ${totalProteins}г белка.\n${goalInfo}`;

      try {
        const analysis = await callOpenAI(env.OPENAI_API_KEY, DAILY_ANALYSIS_PROMPT, userMessage);
        const formattedAnalysis = `🤖 *AI-анализ дня:*\n\n${analysis}`;

        // Cache the result
        await saveInsight(env.DB, userId, "daily", formattedAnalysis);

        return jsonResponse({ analysis: formattedAnalysis, cached: false });
      } catch (error) {
        return jsonResponse({ error: "AI analysis failed" }, 500);
      }
    }

    // GET /api/analyze/week?telegram_id=xxx - AI analysis of weekly data
    if (url.pathname === "/api/analyze/week") {
      const telegramId = url.searchParams.get("telegram_id");
      if (!telegramId) {
        return jsonResponse({ error: "telegram_id required" }, 400);
      }

      const userId = await getUserIdByTelegram(env.DB, telegramId);
      if (!userId) {
        return jsonResponse({ error: "User not found" }, 404);
      }

      // Check cache
      const cached = await getCachedInsight(env.DB, userId, "weekly");
      if (cached) {
        return jsonResponse({ analysis: cached, cached: true });
      }

      // Get weekly data by day
      const weekData = await env.DB.prepare(
        `SELECT
          date(created_at, '+2 hours') as date,
          SUM(calories) as total_calories,
          SUM(proteins) as total_proteins,
          SUM(fats) as total_fats,
          SUM(carbs) as total_carbs,
          COUNT(*) as meal_count
         FROM meals
         WHERE user_id = ? AND date(created_at, '+2 hours') >= date('now', '+2 hours', '-7 days')
         GROUP BY date(created_at, '+2 hours')
         ORDER BY date DESC`
      ).bind(userId).all();

      if (!weekData.results || weekData.results.length < 2) {
        return jsonResponse({
          analysis: "🤖 *AI-анализ недели:*\n\nНедостаточно данных для анализа недели. Отслеживайте питание хотя бы 2-3 дня!",
          cached: false
        });
      }

      // Calculate stats
      const calories = weekData.results.map((d: any) => d.total_calories || 0);
      const avgCal = Math.round(calories.reduce((a: number, b: number) => a + b, 0) / calories.length);
      const minCal = Math.min(...calories);
      const maxCal = Math.max(...calories);
      const totalProteins = weekData.results.reduce((sum: number, d: any) => sum + (d.total_proteins || 0), 0);
      const avgProtein = Math.round(totalProteins / weekData.results.length);
      const daysTracked = weekData.results.length;

      // Get profile
      const profile = await env.DB.prepare(
        `SELECT goal_type, daily_calorie_goal, protein_goal FROM user_profiles WHERE user_id = ?`
      ).bind(userId).first();

      const goalTypes: Record<string, string> = {
        'lose_weight': 'похудение',
        'gain_weight': 'набор массы',
        'maintain': 'поддержание веса'
      };
      const goalType = profile?.goal_type as string || 'lose_weight';
      const calorieGoal = profile?.daily_calorie_goal || 2000;
      const proteinGoal = profile?.protein_goal || 100;

      // Build daily breakdown text
      const dailyText = weekData.results.map((d: any) =>
        `${(d.date as string).slice(5)}: ${d.total_calories || 0} ккал`
      ).join(", ");

      const userMessage = `ДАННЫЕ ЗА НЕДЕЛЮ:
По дням: ${dailyText}
Среднее: ${avgCal} ккал/день | Белок: ${avgProtein}г/день
Разброс: от ${minCal} до ${maxCal} ккал
Дней с записями: ${daysTracked} из 7

ПРОФИЛЬ:
Цель: ${goalTypes[goalType]}
Норма калорий: ${calorieGoal} ккал
Норма белка: ${proteinGoal}г`;

      try {
        const analysis = await callOpenAI(env.OPENAI_API_KEY, WEEKLY_ANALYSIS_PROMPT, userMessage);
        const formattedAnalysis = `🤖 *AI-анализ недели:*\n\n${analysis}`;

        await saveInsight(env.DB, userId, "weekly", formattedAnalysis);

        return jsonResponse({ analysis: formattedAnalysis, cached: false });
      } catch (error) {
        return jsonResponse({ error: "Weekly AI analysis failed" }, 500);
      }
    }

    // GET /api/analyze/month?telegram_id=xxx - AI analysis of monthly data
    if (url.pathname === "/api/analyze/month") {
      const telegramId = url.searchParams.get("telegram_id");
      if (!telegramId) {
        return jsonResponse({ error: "telegram_id required" }, 400);
      }

      const userId = await getUserIdByTelegram(env.DB, telegramId);
      if (!userId) {
        return jsonResponse({ error: "User not found" }, 404);
      }

      // Check cache
      const cached = await getCachedInsight(env.DB, userId, "monthly");
      if (cached) {
        return jsonResponse({ analysis: cached, cached: true });
      }

      // Get monthly summary
      const monthStats = await env.DB.prepare(
        `SELECT
          COUNT(*) as meal_count,
          SUM(calories) as total_calories,
          SUM(proteins) as total_proteins,
          SUM(fats) as total_fats,
          SUM(carbs) as total_carbs,
          AVG(healthiness_score) as avg_healthiness,
          COUNT(DISTINCT date(created_at, '+2 hours')) as days_tracked
         FROM meals
         WHERE user_id = ? AND strftime('%Y-%m', created_at, '+2 hours') = strftime('%Y-%m', 'now', '+2 hours')`
      ).bind(userId).first();

      const daysTracked = (monthStats?.days_tracked as number) || 0;
      if (daysTracked < 2) {
        return jsonResponse({
          analysis: "🤖 *AI-анализ месяца:*\n\nНедостаточно данных для анализа месяца. Продолжайте отслеживать питание!",
          cached: false
        });
      }

      const totalCal = (monthStats?.total_calories as number) || 0;
      const avgCal = Math.round(totalCal / daysTracked);
      const totalProteins = (monthStats?.total_proteins as number) || 0;
      const avgProtein = Math.round(totalProteins / daysTracked);
      const avgHealth = ((monthStats?.avg_healthiness as number) || 0).toFixed(1);

      // Get profile
      const profile = await env.DB.prepare(
        `SELECT goal_type, daily_calorie_goal, protein_goal, current_weight, target_weight FROM user_profiles WHERE user_id = ?`
      ).bind(userId).first();

      const goalTypes: Record<string, string> = {
        'lose_weight': 'похудение',
        'gain_weight': 'набор массы',
        'maintain': 'поддержание веса'
      };
      const goalType = profile?.goal_type as string || 'lose_weight';
      const calorieGoal = profile?.daily_calorie_goal || 2000;
      const proteinGoal = profile?.protein_goal || 100;

      // Get weight change for the month
      const weightHistory = await env.DB.prepare(
        `SELECT weight, date(recorded_at, '+2 hours') as date
         FROM weight_history
         WHERE user_id = ? AND strftime('%Y-%m', recorded_at, '+2 hours') = strftime('%Y-%m', 'now', '+2 hours')
         ORDER BY recorded_at`
      ).bind(userId).all();

      let weightInfo = "ВЕС:\nНет записей веса за этот месяц";
      if (weightHistory.results && weightHistory.results.length > 0) {
        const firstWeight = weightHistory.results[0].weight as number;
        const lastWeight = weightHistory.results[weightHistory.results.length - 1].weight as number;
        const change = lastWeight - firstWeight;
        const changeText = change > 0 ? `+${change.toFixed(1)}` : change.toFixed(1);
        weightInfo = `ВЕС:\nНачало месяца: ${firstWeight} кг\nСейчас: ${lastWeight} кг\nИзменение: ${changeText} кг`;
      }

      const monthName = new Date().toLocaleString('ru-RU', { month: 'long', year: 'numeric' });

      const userMessage = `ИТОГИ МЕСЯЦА (${monthName}):
Дней отслеживания: ${daysTracked}
Всего калорий: ${totalCal} (${avgCal}/день)
Белок: ${Math.round(totalProteins)}г (${avgProtein}г/день)
Полезность еды: ${avgHealth}/10

ПРОФИЛЬ:
Цель: ${goalTypes[goalType]}
Норма: ${calorieGoal} ккал/день
Норма белка: ${proteinGoal}г

${weightInfo}`;

      try {
        const analysis = await callOpenAI(env.OPENAI_API_KEY, MONTHLY_ANALYSIS_PROMPT, userMessage);
        const formattedAnalysis = `🤖 *AI-анализ месяца:*\n\n${analysis}`;

        await saveInsight(env.DB, userId, "monthly", formattedAnalysis);

        return jsonResponse({ analysis: formattedAnalysis, cached: false });
      } catch (error) {
        return jsonResponse({ error: "Monthly AI analysis failed" }, 500);
      }
    }

    // GET /api/tips?telegram_id=xxx - Personalized tips based on week data
    if (url.pathname === "/api/tips") {
      const telegramId = url.searchParams.get("telegram_id");
      if (!telegramId) {
        return jsonResponse({ error: "telegram_id required" }, 400);
      }

      const userId = await getUserIdByTelegram(env.DB, telegramId);
      if (!userId) {
        return jsonResponse({ error: "User not found" }, 404);
      }

      // Check cache
      const cached = await getCachedInsight(env.DB, userId, "tips");
      if (cached) {
        return jsonResponse({ tips: cached, cached: true });
      }

      // Get week's data
      const weekData = await env.DB.prepare(
        `SELECT
          date(created_at, '+2 hours') as date,
          SUM(calories) as total_calories,
          SUM(proteins) as total_proteins,
          COUNT(*) as meal_count,
          AVG(healthiness_score) as avg_health
         FROM meals
         WHERE user_id = ? AND date(created_at, '+2 hours') >= date('now', '+2 hours', '-7 days')
         GROUP BY date(created_at, '+2 hours')
         ORDER BY date`
      ).bind(userId).all();

      if (!weekData.results || weekData.results.length === 0) {
        return jsonResponse({
          tips: "💡 Недостаточно данных для анализа. Отслеживайте питание хотя бы несколько дней!",
          cached: false
        });
      }

      const weekText = weekData.results.map((d: any) =>
        `${d.date}: ${d.total_calories} ккал, ${d.total_proteins}г белка, ${d.meal_count} приёмов пищи`
      ).join("\n");

      const userMessage = `Данные за последнюю неделю:\n${weekText}`;

      try {
        const tips = await callOpenAI(env.OPENAI_API_KEY, TIPS_PROMPT, userMessage);
        const formattedTips = `💡 *Персональные советы:*\n\n${tips}`;

        await saveInsight(env.DB, userId, "tips", formattedTips);

        return jsonResponse({ tips: formattedTips, cached: false });
      } catch (error) {
        return jsonResponse({ error: "Tips generation failed" }, 500);
      }
    }

    // GET /api/predict?telegram_id=xxx - Weight prediction with calculations
    if (url.pathname === "/api/predict") {
      const telegramId = url.searchParams.get("telegram_id");
      if (!telegramId) {
        return jsonResponse({ error: "telegram_id required" }, 400);
      }

      const userId = await getUserIdByTelegram(env.DB, telegramId);
      if (!userId) {
        return jsonResponse({ error: "User not found" }, 404);
      }

      // Get profile with protein_goal
      const profile = await env.DB.prepare(
        `SELECT current_weight, target_weight, daily_calorie_goal, tdee, protein_goal
         FROM user_profiles WHERE user_id = ?`
      ).bind(userId).first() as {
        current_weight: number;
        target_weight: number;
        daily_calorie_goal: number;
        tdee: number;
        protein_goal: number;
      } | null;

      if (!profile) {
        return jsonResponse({
          prediction: "📈 Настройте профиль командой /setgoal для получения прогноза веса.",
          cached: false
        });
      }

      // Get detailed daily stats for last 14 days
      const dailyStats = await env.DB.prepare(
        `SELECT
          date(created_at, '+2 hours') as day,
          SUM(calories) as total_cal,
          SUM(proteins) as total_protein,
          SUM(fats) as total_fat,
          SUM(carbs) as total_carbs,
          COUNT(*) as meal_count
        FROM meals
        WHERE user_id = ? AND date(created_at, '+2 hours') >= date('now', '+2 hours', '-14 days')
        GROUP BY date(created_at, '+2 hours')
        ORDER BY day DESC`
      ).bind(userId).all();

      const days = dailyStats.results as Array<{
        day: string;
        total_cal: number;
        total_protein: number;
        total_fat: number;
        total_carbs: number;
        meal_count: number;
      }>;

      if (!days || days.length < 3) {
        return jsonResponse({
          prediction: "📈 Недостаточно данных. Отслеживайте питание хотя бы 3 дня для прогноза!",
          cached: false
        });
      }

      // Get weight history (last 5 records)
      const weightHistory = await env.DB.prepare(
        `SELECT weight, date(recorded_at) as date
         FROM weight_history
         WHERE user_id = ?
         ORDER BY recorded_at DESC
         LIMIT 5`
      ).bind(userId).all();

      const weights = weightHistory.results as Array<{ weight: number; date: string }>;

      // Calculate statistics
      const daysTracked = days.length;
      const totalCalories = days.reduce((sum, d) => sum + (d.total_cal || 0), 0);
      const totalProtein = days.reduce((sum, d) => sum + (d.total_protein || 0), 0);
      const totalMeals = days.reduce((sum, d) => sum + (d.meal_count || 0), 0);

      const avgDailyCalories = Math.round(totalCalories / daysTracked);
      const avgDailyProtein = Math.round(totalProtein / daysTracked);

      // Calculate deficit/surplus and predictions (7700 kcal = 1 kg)
      const dailyDeficit = profile.tdee - avgDailyCalories;
      const monthlyDeficitKcal = dailyDeficit * 30;
      const expectedMonthlyLossKg = monthlyDeficitKcal / 7700;
      const predictedWeight = profile.current_weight - expectedMonthlyLossKg;

      // Calculate weeks to goal
      const weightToLose = profile.current_weight - profile.target_weight;
      const weeklyLoss = (dailyDeficit * 7) / 7700;
      const weeksToGoal = weeklyLoss > 0 ? Math.ceil(weightToLose / weeklyLoss) : null;

      // Assess trends
      const proteinPercent = profile.protein_goal > 0
        ? Math.round((avgDailyProtein / profile.protein_goal) * 100)
        : 0;
      const proteinStatus = proteinPercent >= 90 ? "good" : proteinPercent >= 70 ? "ok" : "low";

      const consistencyPercent = Math.round((daysTracked / 14) * 100);
      const consistencyStatus = consistencyPercent >= 80 ? "good" : consistencyPercent >= 50 ? "ok" : "low";

      let direction: string;
      if (dailyDeficit > 100) {
        direction = "losing";
      } else if (dailyDeficit < -100) {
        direction = "gaining";
      } else {
        direction = "stable";
      }

      // Build structured message for AI
      const userMessage = `ПРОФИЛЬ:
• Текущий вес: ${profile.current_weight} кг
• Целевой вес: ${profile.target_weight} кг
• TDEE (расход): ${profile.tdee} ккал/день
• Цель калорий: ${profile.daily_calorie_goal} ккал/день
• Цель белка: ${profile.protein_goal} г/день

СТАТИСТИКА (${daysTracked} дней):
• Средние калории: ${avgDailyCalories} ккал/день
• Средний белок: ${avgDailyProtein} г/день (${proteinPercent}% от цели)
• Всего приёмов пищи: ${totalMeals}
• Стабильность отслеживания: ${consistencyPercent}%

РАСЧЁТЫ (7700 ккал = 1 кг):
• Дневной дефицит: ${dailyDeficit > 0 ? '+' : ''}${dailyDeficit} ккал
• Месячный дефицит: ${monthlyDeficitKcal > 0 ? '+' : ''}${monthlyDeficitKcal} ккал
• Ожидаемое изменение за месяц: ${expectedMonthlyLossKg > 0 ? '-' : '+'}${Math.abs(expectedMonthlyLossKg).toFixed(2)} кг
• ПРОГНОЗ ВЕСА ЧЕРЕЗ МЕСЯЦ: ${predictedWeight.toFixed(1)} кг
${weeksToGoal && weeksToGoal > 0 ? `• До цели: ~${weeksToGoal} недель` : ''}

ОЦЕНКА:
• Направление: ${direction === 'losing' ? 'похудение' : direction === 'gaining' ? 'набор' : 'поддержание'}
• Белок: ${proteinStatus === 'good' ? 'достаточно' : proteinStatus === 'ok' ? 'немного мало' : 'недостаточно'}
• Стабильность: ${consistencyStatus === 'good' ? 'хорошая' : consistencyStatus === 'ok' ? 'средняя' : 'низкая'}
${weights.length > 0 ? `\nИСТОРИЯ ВЕСА: ${weights.map(w => `${w.weight}кг (${w.date})`).join(', ')}` : ''}`;

      try {
        const aiAnalysis = await callOpenAI(env.OPENAI_API_KEY, PREDICT_PROMPT, userMessage);

        // Build formatted prediction with our calculations
        let formattedPrediction = `📈 *Прогноз на месяц*\n\n`;
        formattedPrediction += `⚖️ Ожидаемый вес: *${predictedWeight.toFixed(1)} кг* (сейчас ${profile.current_weight} кг)\n`;

        if (expectedMonthlyLossKg > 0) {
          formattedPrediction += `📉 Потеря: ~${expectedMonthlyLossKg.toFixed(1)} кг\n`;
        } else if (expectedMonthlyLossKg < 0) {
          formattedPrediction += `📈 Набор: ~${Math.abs(expectedMonthlyLossKg).toFixed(1)} кг\n`;
        } else {
          formattedPrediction += `➡️ Вес стабилен\n`;
        }

        if (weeksToGoal && weeksToGoal > 0 && weeksToGoal < 200) {
          formattedPrediction += `🎯 До цели (${profile.target_weight} кг): ~${weeksToGoal} нед.\n`;
        }

        formattedPrediction += `\n🤖 *AI-оценка:*\n${aiAnalysis}`;

        return jsonResponse({ prediction: formattedPrediction, cached: false });
      } catch (error) {
        // Fallback: return calculations without AI
        let fallbackPrediction = `📈 *Прогноз на месяц*\n\n`;
        fallbackPrediction += `⚖️ Ожидаемый вес: *${predictedWeight.toFixed(1)} кг* (сейчас ${profile.current_weight} кг)\n`;
        fallbackPrediction += `📊 Дневной дефицит: ${dailyDeficit} ккал\n`;
        fallbackPrediction += `📉 Ожидаемая потеря: ~${expectedMonthlyLossKg.toFixed(1)} кг/мес`;

        return jsonResponse({ prediction: fallbackPrediction, cached: false });
      }
    }

    // MCP SSE endpoint with user code
    // Pass userCode through props since serveSSE() rewrites the URL
    if (url.pathname.startsWith("/sse")) {
      const userCode = url.searchParams.get("code");
      const ctxWithProps = { ...ctx, props: { userCode } };
      return CaloriesMCP.serveSSE("/sse").fetch(request, env, ctxWithProps);
    }

    // MCP Streamable HTTP endpoint
    if (url.pathname.startsWith("/mcp")) {
      const userCode = url.searchParams.get("code");
      const ctxWithProps = { ...ctx, props: { userCode } };
      return CaloriesMCP.serve("/mcp").fetch(request, env, ctxWithProps);
    }

    return new Response("Not Found", { status: 404 });
  },
};
