import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Environment types
export interface Env {
  DB: D1Database;
  MCP_OBJECT: DurableObjectNamespace;
  OPENAI_API_KEY: string;
}

function wantsEventStream(request: Request): boolean {
  const accept = request.headers.get("accept") || "";
  return accept.includes("text/event-stream");
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

// Get Kyiv timezone offset with DST support
// Kyiv: UTC+2 in winter, UTC+3 in summer (DST)
// DST starts: last Sunday of March at 03:00 local (01:00 UTC)
// DST ends: last Sunday of October at 04:00 local (01:00 UTC)
function getKyivOffset(): string {
  const now = new Date();
  const year = now.getUTCFullYear();

  // Last Sunday of March
  const marchLast = new Date(Date.UTC(year, 2, 31));
  while (marchLast.getUTCDay() !== 0) {
    marchLast.setUTCDate(marchLast.getUTCDate() - 1);
  }
  marchLast.setUTCHours(1, 0, 0, 0); // 01:00 UTC

  // Last Sunday of October
  const octLast = new Date(Date.UTC(year, 9, 31));
  while (octLast.getUTCDay() !== 0) {
    octLast.setUTCDate(octLast.getUTCDate() - 1);
  }
  octLast.setUTCHours(1, 0, 0, 0); // 01:00 UTC

  const utcNow = now.getTime();
  const isDST = utcNow >= marchLast.getTime() && utcNow < octLast.getTime();

  return isDST ? '+3 hours' : '+2 hours';
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
3. Регулярность отслеживания — оценивай по ПРОЦЕНТУ дней с записями
4. Главные достижения и вызовы

ОЦЕНКА ДИСЦИПЛИНЫ (по проценту):
- 90-100% = отличная дисциплина, похвали!
- 70-89% = хорошая дисциплина
- 50-69% = средняя, есть куда расти
- Ниже 50% = нужно улучшить регулярность

ФОРМАТ:
🏆 *Итог месяца:* [главное достижение или вызов]
📈 *Статистика:* [ключевые цифры]
🎯 *Стратегия:* [совет на следующий месяц]

ПРАВИЛА:
- Это ИТОГОВЫЙ анализ — будь позитивным но честным
- Фокус на привычках, не на отдельных днях
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
  const tz = getKyivOffset();
  const cached = await db.prepare(
    `SELECT content FROM ai_insights
     WHERE user_id = ? AND insight_type = ? AND insight_date = date('now', '${tz}')
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
  const tz = getKyivOffset();
  await db.prepare(
    `INSERT OR REPLACE INTO ai_insights (user_id, insight_type, insight_date, content)
     VALUES (?, ?, date('now', '${tz}'), ?)`
  ).bind(userId, insightType, content).run();
}

// Invalidate all cached insights when data changes (daily, weekly, monthly, tips)
async function invalidateDailyInsight(
  db: D1Database,
  userId: number
): Promise<void> {
  const tz = getKyivOffset();
  await db.prepare(
    `DELETE FROM ai_insights
     WHERE user_id = ? AND insight_date = date('now', '${tz}')`
  ).bind(userId).run();
}

// Log errors to database for debugging
async function logError(
  db: D1Database,
  toolName: string,
  error: unknown,
  userCode?: string | null,
  userId?: number | null,
  rawArgs?: unknown
): Promise<void> {
  try {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    await db.prepare(
      `INSERT INTO error_logs (tool_name, error_message, error_stack, user_code, user_id, raw_args)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      toolName,
      errorMessage,
      errorStack || null,
      userCode || null,
      userId || null,
      rawArgs ? JSON.stringify(rawArgs) : null
    ).run();

    console.error(`[MCP ERROR] ${toolName}: ${errorMessage}`);
  } catch (logErr) {
    // Don't fail if logging fails
    console.error(`[MCP] Failed to log error:`, logErr);
  }
}

// Parse date string for backdated records (e.g., "yesterday", "2026-01-10")
// Returns datetime string in UTC for SQLite or null to use current time
function parseRecordDate(dateStr?: string): string | null {
  if (!dateStr) return null;

  // Calculate Kyiv offset in hours
  const kyivOffsetHours = getKyivOffset() === '+3 hours' ? 3 : 2;

  // Current time in Kyiv
  const now = new Date();
  const kyivNow = new Date(now.getTime() + kyivOffsetHours * 60 * 60 * 1000);

  if (dateStr.toLowerCase() === 'yesterday') {
    // Yesterday in Kyiv
    const yesterday = new Date(kyivNow);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);

    const year = yesterday.getUTCFullYear();
    const month = String(yesterday.getUTCMonth() + 1).padStart(2, '0');
    const day = String(yesterday.getUTCDate()).padStart(2, '0');

    // 12:00 Kyiv time -> UTC
    const utcHour = 12 - kyivOffsetHours;
    return `${year}-${month}-${day} ${String(utcHour).padStart(2, '0')}:00:00`;
  }

  // Validate YYYY-MM-DD format
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateStr)) {
    return null;
  }

  // Check: not in the future (Kyiv time)
  const todayKyiv = kyivNow.toISOString().split('T')[0];
  if (dateStr > todayKyiv) {
    return null;
  }

  // Check: not older than 7 days
  const weekAgo = new Date(kyivNow);
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
  const weekAgoStr = weekAgo.toISOString().split('T')[0];
  if (dateStr < weekAgoStr) {
    return null;
  }

  // 12:00 Kyiv time -> UTC
  const utcHour = 12 - kyivOffsetHours;
  return `${dateStr} ${String(utcHour).padStart(2, '0')}:00:00`;
}

// MCP Server with Calories Tracker tools (multi-user support)
export class CaloriesMCP extends McpAgent<Env, unknown, unknown> {
  server = new McpServer({
    name: "calories-tracker",
    version: "2.0.0",
  });

  // Helper to get userId - checks props first, then storage
  private async getUserId(): Promise<number | null> {
    console.log("[MCP] getUserId() called");

    // 1. Try to get from props (passed from fetch handler)
    const props = this.props as { userCode?: string } | undefined;
    let userCode = props?.userCode || null;
    console.log(`[MCP] userCode from props: ${userCode}`);

    // 2. If not in props, try storage (for subsequent tool calls)
    if (!userCode) {
      userCode = await this.ctx.storage.get("userCode") as string | null;
      console.log(`[MCP] userCode from storage: ${userCode}`);
    }

    // 3. If we have a code, save to storage for future calls
    if (userCode) {
      await this.ctx.storage.put("userCode", userCode);
    }

    if (!userCode) {
      console.error("[MCP] No userCode found in props or storage");
      return null;
    }

    const userId = await getUserIdByCode(this.env.DB, userCode);
    console.log(`[MCP] userId for code ${userCode}: ${userId}`);
    return userId;
  }

  // Helper to get userCode for error logging
  private async getUserCode(): Promise<string | null> {
    const props = this.props as { userCode?: string } | undefined;
    return props?.userCode || await this.ctx.storage.get("userCode") as string | null;
  }

  // Wrapper to add try-catch to any tool handler
  private wrapHandler<T>(
    toolName: string,
    handler: (args: T) => Promise<{ content: Array<{ type: "text"; text: string }> }>
  ): (args: T) => Promise<{ content: Array<{ type: "text"; text: string }> }> {
    return async (args: T) => {
      const userCode = await this.getUserCode();
      let userId: number | null = null;
      try {
        userId = await this.getUserId();
        return await handler(args);
      } catch (error) {
        console.error(`[MCP] ${toolName} error:`, error);
        await logError(this.env.DB, toolName, error, userCode, userId, args);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: `Failed to execute ${toolName}`,
              message: error instanceof Error ? error.message : String(error),
              hint: "Error has been logged. Try again or check /api/errors"
            })
          }]
        };
      }
    };
  }

  async init() {
    // Store user code from props (passed from fetch handler via ctx.props)
    const props = this.props as { userCode?: string } | undefined;
    console.log(`[MCP] init() called, props.userCode: ${props?.userCode}`);
    if (props?.userCode) {
      await this.ctx.storage.put("userCode", props.userCode);
      console.log(`[MCP] Saved userCode to storage: ${props.userCode}`);
    }

    // Tool: add_meal
    // Support both standard names and ChatGPT's alternative names
    this.server.tool(
      "add_meal",
      "Add a new meal to the calories tracker. Use this when the user sends food photos or describes what they ate.",
      {
        // Standard names
        meal_name: z.string().optional().describe("Name of the meal or dish"),
        calories: z.number().optional().describe("Estimated calories (kcal)"),
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
        // ChatGPT alternative names
        name: z.string().optional().describe("Alternative: Name of the meal"),
        calories_kcal: z.number().optional().describe("Alternative: Calories in kcal"),
        protein_g: z.number().optional().describe("Alternative: Protein in grams"),
        fat_g: z.number().optional().describe("Alternative: Fat in grams"),
        carbs_g: z.number().optional().describe("Alternative: Carbs in grams"),
        fiber_g: z.number().optional().describe("Alternative: Fiber in grams"),
        health_score: z.number().optional().describe("Alternative: Health score 1-10"),
        // Date for backdated records
        date: z.string().optional().describe("Date for the record: 'yesterday' or 'YYYY-MM-DD' format. If not provided, uses current time. Max 7 days back."),
      },
      async (rawArgs) => {
        const props = this.props as { userCode?: string } | undefined;
        const userCode = props?.userCode || await this.ctx.storage.get("userCode") as string | null;
        let userId: number | null = null;

        try {
          // Normalize arguments: support both standard and ChatGPT alternative names
          const args = {
            meal_name: rawArgs.meal_name || rawArgs.name || "Unknown meal",
            calories: rawArgs.calories || rawArgs.calories_kcal || 0,
            proteins: rawArgs.proteins || rawArgs.protein_g,
            fats: rawArgs.fats || rawArgs.fat_g,
            carbs: rawArgs.carbs || rawArgs.carbs_g,
            fiber: rawArgs.fiber || rawArgs.fiber_g,
            water_ml: rawArgs.water_ml,
            meal_type: rawArgs.meal_type,
            healthiness_score: rawArgs.healthiness_score || rawArgs.health_score,
            notes: rawArgs.notes,
            date: rawArgs.date,
          };

          // Parse date for backdated records
          const recordDate = parseRecordDate(args.date);
          const isBackdated = recordDate !== null;

          console.log(`[MCP] add_meal called: ${args.meal_name}, ${args.calories} kcal, date: ${args.date || 'now'} (raw: ${JSON.stringify(rawArgs)})`);

          userId = await this.getUserId();
          if (!userId) {
            console.error(`[MCP] add_meal failed: user not found for code ${userCode}`);
            await logError(this.env.DB, "add_meal", "User not authenticated", userCode, null, rawArgs);
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  error: "User not authenticated",
                  hint: "Please register via Telegram bot first using /register command",
                  userCode: userCode || "not provided"
                })
              }],
            };
          }

          // Check for duplicate meal (same name and similar calories within last 3 minutes)
          // Skip duplicate check for backdated records
          if (!isBackdated) {
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
          }

          const tz = getKyivOffset();
          const result = await this.env.DB.prepare(
            `INSERT INTO meals (user_id, meal_name, calories, proteins, fats, carbs, fiber, water_ml, meal_type, healthiness_score, notes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(datetime(?), datetime('now')))`
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
              args.notes ?? null,
              recordDate
            )
            .run();

          // Invalidate daily AI analysis cache so next analysis is fresh
          await invalidateDailyInsight(this.env.DB, userId);

          const dateInfo = isBackdated ? ` for ${args.date}` : '';
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  message: `Meal "${args.meal_name}" added successfully${dateInfo}!`,
                  calories: args.calories,
                  id: result.meta.last_row_id,
                  recorded_for: isBackdated ? args.date : 'today',
                }),
              },
            ],
          };
        } catch (error) {
          console.error(`[MCP] add_meal error:`, error);
          await logError(this.env.DB, "add_meal", error, userCode, userId, rawArgs);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "Failed to add meal",
                message: error instanceof Error ? error.message : String(error),
                hint: "Error has been logged. Try again or contact support."
              })
            }],
          };
        }
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
        date: z.string().optional().describe("Date for the record: 'yesterday' or 'YYYY-MM-DD' format. If not provided, uses current time. Max 7 days back."),
      },
      async (args) => {
        const props = this.props as { userCode?: string } | undefined;
        const userCode = props?.userCode || await this.ctx.storage.get("userCode") as string | null;
        let userId: number | null = null;

        try {
          // Parse date for backdated records
          const recordDate = parseRecordDate(args.date);
          const isBackdated = recordDate !== null;

          userId = await this.getUserId();
          if (!userId) {
            await logError(this.env.DB, "add_water", "User not authenticated", userCode, null, args);
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

          const tz = getKyivOffset();
          const result = await this.env.DB.prepare(
            `INSERT INTO meals (user_id, meal_name, calories, proteins, fats, carbs, fiber, water_ml, meal_type, healthiness_score, notes, created_at)
             VALUES (?, ?, ?, 0, 0, 0, 0, ?, 'other', ?, ?, COALESCE(datetime(?), datetime('now')))`
          )
            .bind(
              userId,
              `${beverageNames[beverageType]} ${args.amount_ml}мл`,
              beverageType === "juice" ? Math.round(args.amount_ml * 0.4) : 0,
              args.amount_ml,
              beverageType === "water" ? 10 : 8,
              args.notes ?? null,
              recordDate
            )
            .run();

          // Invalidate daily AI analysis cache
          await invalidateDailyInsight(this.env.DB, userId);

          const dateInfo = isBackdated ? ` for ${args.date}` : '';
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  message: `Recorded ${args.amount_ml}ml of ${beverageType}${dateInfo}`,
                  amount_ml: args.amount_ml,
                  id: result.meta.last_row_id,
                  recorded_for: isBackdated ? args.date : 'today',
                }),
              },
            ],
          };
        } catch (error) {
          console.error(`[MCP] add_water error:`, error);
          await logError(this.env.DB, "add_water", error, userCode, userId, args);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "Failed to add water",
                message: error instanceof Error ? error.message : String(error)
              })
            }],
          };
        }
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
        date: z.string().optional().describe("Date for the record: 'yesterday' or 'YYYY-MM-DD' format. If not provided, uses current time. Max 7 days back."),
      },
      async (args) => {
        const userCode = await this.getUserCode();
        let userId: number | null = null;

        try {
          // Parse date for backdated records
          const recordDate = parseRecordDate(args.date);
          const isBackdated = recordDate !== null;

          userId = await this.getUserId();
          if (!userId) {
            await logError(this.env.DB, "add_activity", "User not authenticated", userCode, null, args);
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

          const tz = getKyivOffset();
          const result = await this.env.DB.prepare(
            `INSERT INTO activities (user_id, activity_type, duration_minutes, intensity, calories_burned, description, notes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(datetime(?), datetime('now')))`
          ).bind(
            userId,
            args.activity_type,
            args.duration_minutes,
            intensity,
            caloriesBurned,
            args.description || null,
            args.notes || null,
            recordDate
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

          const dateInfo = isBackdated ? ` за ${args.date}` : '';
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                message: `${activityNames[args.activity_type]} записана${dateInfo}: ${args.duration_minutes} мин, ${caloriesBurned} ккал сожжено`,
                activity_type: args.activity_type,
                duration_minutes: args.duration_minutes,
                intensity,
                calories_burned: caloriesBurned,
                id: result.meta.last_row_id,
                recorded_for: isBackdated ? args.date : 'today',
              }),
            }],
          };
        } catch (error) {
          console.error(`[MCP] add_activity error:`, error);
          await logError(this.env.DB, "add_activity", error, userCode, userId, args);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "Failed to add activity",
                message: error instanceof Error ? error.message : String(error)
              })
            }],
          };
        }
      }
    );

    // Tool: get_today_summary
    this.server.tool(
      "get_today_summary",
      "Get nutrition summary for today including total calories, macros, and all meals.",
      {},
      async () => {
        const props = this.props as { userCode?: string } | undefined;
        const userCode = props?.userCode || await this.ctx.storage.get("userCode") as string | null;
        let userId: number | null = null;

        try {
          userId = await this.getUserId();
          if (!userId) {
            await logError(this.env.DB, "get_today_summary", "User not authenticated", userCode, null, {});
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: "User not authenticated" }) }],
            };
          }

          const tz = getKyivOffset();
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
             WHERE user_id = ? AND date(created_at, '${tz}') = date('now', '${tz}')`
          ).bind(userId).first();

          const meals = await this.env.DB.prepare(
            `SELECT id, meal_name, calories, proteins, fats, carbs, meal_type, healthiness_score,
                    strftime('%H:%M', created_at, '${tz}') as time
             FROM meals
             WHERE user_id = ? AND date(created_at, '${tz}') = date('now', '${tz}')
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
        } catch (error) {
          console.error(`[MCP] get_today_summary error:`, error);
          await logError(this.env.DB, "get_today_summary", error, userCode, userId, {});
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "Failed to get today summary",
                message: error instanceof Error ? error.message : String(error)
              })
            }],
          };
        }
      }
    );

    // Tool: get_weekly_summary
    this.server.tool(
      "get_weekly_summary",
      "Get nutrition summary for the last 7 days with daily breakdown.",
      {},
      async () => {
        const userCode = await this.getUserCode();
        let userId: number | null = null;

        try {
          userId = await this.getUserId();
          if (!userId) {
            await logError(this.env.DB, "get_weekly_summary", "User not authenticated", userCode, null, {});
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: "User not authenticated" }) }],
            };
          }

          const tz = getKyivOffset();
          const dailyStats = await this.env.DB.prepare(
            `SELECT
              date(created_at, '${tz}') as date,
              COUNT(*) as meal_count,
              SUM(calories) as total_calories,
              SUM(proteins) as total_proteins,
              SUM(fats) as total_fats,
              SUM(carbs) as total_carbs,
              AVG(healthiness_score) as avg_healthiness
             FROM meals
             WHERE user_id = ? AND date(created_at, '${tz}') >= date('now', '${tz}', '-7 days')
             GROUP BY date(created_at, '${tz}')
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
             WHERE user_id = ? AND date(created_at, '${tz}') >= date('now', '${tz}', '-7 days')`
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
        } catch (error) {
          console.error(`[MCP] get_weekly_summary error:`, error);
          await logError(this.env.DB, "get_weekly_summary", error, userCode, userId, {});
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "Failed to get weekly summary",
                message: error instanceof Error ? error.message : String(error)
              })
            }],
          };
        }
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

        const tz = getKyivOffset();
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
            COUNT(DISTINCT date(created_at, '${tz}')) as days_tracked
           FROM meals
           WHERE user_id = ? AND strftime('%Y-%m', created_at, '${tz}') = strftime('%Y-%m', 'now', '${tz}')`
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
        const tz = getKyivOffset();
        const history = await this.env.DB.prepare(
          `SELECT weight, notes, datetime(recorded_at, '${tz}') as recorded_at
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

    // Tool: delete_meal
    this.server.tool(
      "delete_meal",
      "Delete a meal from the tracker. Use when user wants to remove a recorded meal.",
      {
        meal_id: z.number().describe("ID of the meal to delete"),
      },
      async (args) => {
        const userId = await this.getUserId();
        if (!userId) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "User not authenticated" }) }],
          };
        }

        // Check if meal exists and belongs to user
        const meal = await this.env.DB.prepare(
          "SELECT id, meal_name FROM meals WHERE id = ? AND user_id = ?"
        ).bind(args.meal_id, userId).first();

        if (!meal) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: "Meal not found or doesn't belong to you", meal_id: args.meal_id }),
            }],
          };
        }

        await this.env.DB.prepare("DELETE FROM meals WHERE id = ? AND user_id = ?")
          .bind(args.meal_id, userId).run();

        // Invalidate daily AI analysis cache
        await invalidateDailyInsight(this.env.DB, userId);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              message: `Meal "${meal.meal_name}" deleted`,
              deleted_id: args.meal_id,
            }),
          }],
        };
      }
    );

    // Tool: edit_meal
    this.server.tool(
      "edit_meal",
      "Edit an existing meal. Use when user wants to correct calories, name, or other details of a recorded meal.",
      {
        meal_id: z.number().describe("ID of the meal to edit"),
        meal_name: z.string().optional().describe("New name for the meal"),
        calories: z.number().optional().describe("New calorie value"),
        proteins: z.number().optional().describe("New protein value in grams"),
        fats: z.number().optional().describe("New fat value in grams"),
        carbs: z.number().optional().describe("New carbs value in grams"),
        fiber: z.number().optional().describe("New fiber value in grams"),
        meal_type: z.enum(["breakfast", "lunch", "dinner", "snack", "other"]).optional().describe("New meal type"),
        healthiness_score: z.number().min(1).max(10).optional().describe("New health score 1-10"),
        notes: z.string().optional().describe("New notes"),
      },
      async (args) => {
        const userId = await this.getUserId();
        if (!userId) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "User not authenticated" }) }],
          };
        }

        // Check if meal exists and belongs to user
        const meal = await this.env.DB.prepare(
          "SELECT * FROM meals WHERE id = ? AND user_id = ?"
        ).bind(args.meal_id, userId).first();

        if (!meal) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: "Meal not found or doesn't belong to you", meal_id: args.meal_id }),
            }],
          };
        }

        // Build update query dynamically
        const updates: string[] = [];
        const values: unknown[] = [];

        if (args.meal_name !== undefined) { updates.push("meal_name = ?"); values.push(args.meal_name); }
        if (args.calories !== undefined) { updates.push("calories = ?"); values.push(args.calories); }
        if (args.proteins !== undefined) { updates.push("proteins = ?"); values.push(args.proteins); }
        if (args.fats !== undefined) { updates.push("fats = ?"); values.push(args.fats); }
        if (args.carbs !== undefined) { updates.push("carbs = ?"); values.push(args.carbs); }
        if (args.fiber !== undefined) { updates.push("fiber = ?"); values.push(args.fiber); }
        if (args.meal_type !== undefined) { updates.push("meal_type = ?"); values.push(args.meal_type); }
        if (args.healthiness_score !== undefined) { updates.push("healthiness_score = ?"); values.push(args.healthiness_score); }
        if (args.notes !== undefined) { updates.push("notes = ?"); values.push(args.notes); }

        if (updates.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: "No fields to update provided" }),
            }],
          };
        }

        values.push(args.meal_id, userId);
        await this.env.DB.prepare(
          `UPDATE meals SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`
        ).bind(...values).run();

        // Invalidate daily AI analysis cache
        await invalidateDailyInsight(this.env.DB, userId);

        // Get updated meal
        const updated = await this.env.DB.prepare(
          "SELECT * FROM meals WHERE id = ?"
        ).bind(args.meal_id).first();

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              message: "Meal updated successfully",
              meal: updated,
            }, null, 2),
          }],
        };
      }
    );

    // Tool: get_activity_history
    this.server.tool(
      "get_activity_history",
      "Get activity/exercise history. Use to show past workouts and exercises.",
      {
        limit: z.number().optional().describe("Number of records to return (default: 10)"),
      },
      async (args) => {
        const userId = await this.getUserId();
        if (!userId) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "User not authenticated" }) }] };
        }

        const limit = args.limit ?? 10;
        const tz = getKyivOffset();
        const activities = await this.env.DB.prepare(
          `SELECT id, activity_type, duration_minutes, intensity, calories_burned, description, notes,
                  datetime(created_at, '${tz}') as created_at
           FROM activities WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
        ).bind(userId, limit).all();

        const activityNames: Record<string, string> = { walking: 'Ходьба', running: 'Бег', cycling: 'Велосипед', gym: 'Тренажёрный зал', swimming: 'Плавание', yoga: 'Йога', other: 'Активность' };

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              count: activities.results.length,
              activities: activities.results.map(a => ({ ...a, activity_name: activityNames[(a as Record<string, unknown>).activity_type as string] || 'Активность' })),
            }, null, 2),
          }],
        };
      }
    );

    // Tool: delete_activity
    this.server.tool(
      "delete_activity",
      "Delete an activity/exercise record. Use when user wants to remove a recorded workout.",
      {
        activity_id: z.number().describe("ID of the activity to delete"),
      },
      async (args) => {
        const userId = await this.getUserId();
        if (!userId) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "User not authenticated" }) }] };
        }

        const activity = await this.env.DB.prepare(
          "SELECT id, activity_type, duration_minutes FROM activities WHERE id = ? AND user_id = ?"
        ).bind(args.activity_id, userId).first();

        if (!activity) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Activity not found", activity_id: args.activity_id }) }] };
        }

        await this.env.DB.prepare("DELETE FROM activities WHERE id = ? AND user_id = ?").bind(args.activity_id, userId).run();
        await invalidateDailyInsight(this.env.DB, userId);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, message: `Activity deleted`, deleted_id: args.activity_id }),
          }],
        };
      }
    );

    // Tool: edit_activity
    this.server.tool(
      "edit_activity",
      "Edit an existing activity/exercise. Use when user wants to correct duration, calories, or other details.",
      {
        activity_id: z.number().describe("ID of the activity to edit"),
        activity_type: z.enum(["walking", "running", "cycling", "gym", "swimming", "yoga", "other"]).optional(),
        duration_minutes: z.number().optional().describe("New duration in minutes"),
        intensity: z.enum(["light", "moderate", "vigorous"]).optional(),
        calories_burned: z.number().optional().describe("New calories burned"),
        description: z.string().optional(),
        notes: z.string().optional(),
      },
      async (args) => {
        const userId = await this.getUserId();
        if (!userId) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "User not authenticated" }) }] };
        }

        const activity = await this.env.DB.prepare(
          "SELECT * FROM activities WHERE id = ? AND user_id = ?"
        ).bind(args.activity_id, userId).first();

        if (!activity) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Activity not found", activity_id: args.activity_id }) }] };
        }

        const updates: string[] = [];
        const values: unknown[] = [];
        if (args.activity_type !== undefined) { updates.push("activity_type = ?"); values.push(args.activity_type); }
        if (args.duration_minutes !== undefined) { updates.push("duration_minutes = ?"); values.push(args.duration_minutes); }
        if (args.intensity !== undefined) { updates.push("intensity = ?"); values.push(args.intensity); }
        if (args.calories_burned !== undefined) { updates.push("calories_burned = ?"); values.push(args.calories_burned); }
        if (args.description !== undefined) { updates.push("description = ?"); values.push(args.description); }
        if (args.notes !== undefined) { updates.push("notes = ?"); values.push(args.notes); }

        if (updates.length === 0) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "No fields to update" }) }] };
        }

        values.push(args.activity_id, userId);
        await this.env.DB.prepare(`UPDATE activities SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`).bind(...values).run();
        await invalidateDailyInsight(this.env.DB, userId);

        const updated = await this.env.DB.prepare("SELECT * FROM activities WHERE id = ?").bind(args.activity_id).first();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, message: "Activity updated", activity: updated }, null, 2),
          }],
        };
      }
    );

    // Tool: search_meals
    this.server.tool(
      "search_meals",
      "Search meals in history by name. Use when user asks about specific food they ate before.",
      {
        query: z.string().describe("Search term to find in meal names"),
        limit: z.number().optional().describe("Max results (default: 10)"),
      },
      async (args) => {
        const userId = await this.getUserId();
        if (!userId) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "User not authenticated" }) }] };
        }

        const limit = args.limit ?? 10;
        const meals = await this.env.DB.prepare(
          `SELECT id, meal_name, calories, proteins, fats, carbs, meal_type, created_at
           FROM meals WHERE user_id = ? AND meal_name LIKE ? ORDER BY created_at DESC LIMIT ?`
        ).bind(userId, `%${args.query}%`, limit).all();

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ query: args.query, count: meals.results.length, meals: meals.results }, null, 2),
          }],
        };
      }
    );

    // Tool: delete_weight
    this.server.tool(
      "delete_weight",
      "Delete a weight record. Use when user wants to remove an incorrect weight entry.",
      {
        weight_id: z.number().describe("ID of the weight record to delete"),
      },
      async (args) => {
        const userId = await this.getUserId();
        if (!userId) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "User not authenticated" }) }] };
        }

        const record = await this.env.DB.prepare(
          "SELECT id, weight FROM weight_history WHERE id = ? AND user_id = ?"
        ).bind(args.weight_id, userId).first();

        if (!record) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Weight record not found", weight_id: args.weight_id }) }] };
        }

        await this.env.DB.prepare("DELETE FROM weight_history WHERE id = ? AND user_id = ?").bind(args.weight_id, userId).run();

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, message: `Weight record ${record.weight}kg deleted`, deleted_id: args.weight_id }),
          }],
        };
      }
    );

    // Tool: get_recommendations
    this.server.tool(
      "get_recommendations",
      "Get food recommendations based on remaining calories and macros for today. Use to suggest what user can still eat.",
      {},
      async () => {
        const userId = await this.getUserId();
        if (!userId) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "User not authenticated" }) }] };
        }

        const profile = await this.env.DB.prepare(
          "SELECT daily_calorie_goal, protein_goal FROM user_profiles WHERE user_id = ?"
        ).bind(userId).first();

        if (!profile) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Profile not set up. Use set_user_profile first." }) }] };
        }

        const tz = getKyivOffset();
        const today = await this.env.DB.prepare(
          `SELECT COALESCE(SUM(calories), 0) as calories, COALESCE(SUM(proteins), 0) as proteins,
                  COALESCE(SUM(fats), 0) as fats, COALESCE(SUM(carbs), 0) as carbs
           FROM meals WHERE user_id = ? AND date(created_at, '${tz}') = date('now', '${tz}')`
        ).bind(userId).first();

        const calorieGoal = profile.daily_calorie_goal as number;
        const proteinGoal = profile.protein_goal as number;
        const caloriesEaten = (today?.calories || 0) as number;
        const proteinEaten = (today?.proteins || 0) as number;
        const caloriesLeft = calorieGoal - caloriesEaten;
        const proteinLeft = proteinGoal - proteinEaten;

        let recommendations: string[] = [];
        if (caloriesLeft <= 0) {
          recommendations.push("Дневной лимит калорий достигнут. Рекомендуется не есть больше или выбрать очень лёгкие продукты.");
        } else if (caloriesLeft < 200) {
          recommendations.push(`Осталось мало калорий (${caloriesLeft} ккал). Подойдут: овощной салат, огурцы, зелёный чай.`);
        } else if (proteinLeft > 20) {
          recommendations.push(`Нужно добрать белок (${Math.round(proteinLeft)}г). Подойдут: куриная грудка, творог, яйца, рыба.`);
        } else if (caloriesLeft > 500) {
          recommendations.push(`Ещё можно съесть полноценный приём пищи (~${caloriesLeft} ккал).`);
        } else {
          recommendations.push(`Осталось ${caloriesLeft} ккал. Подойдёт лёгкий перекус или небольшой ужин.`);
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              remaining: { calories: caloriesLeft, protein: Math.round(proteinLeft) },
              eaten_today: { calories: caloriesEaten, protein: Math.round(proteinEaten) },
              goals: { calories: calorieGoal, protein: proteinGoal },
              recommendations,
            }, null, 2),
          }],
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
          "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    // Health check
    if (url.pathname === "/health") {
      return jsonResponse({ status: "ok" });
    }

    // Error logs viewer (for debugging)
    if (url.pathname === "/api/errors") {
      const limit = parseInt(url.searchParams.get("limit") || "20");
      const userCode = url.searchParams.get("code");

      let query = `SELECT * FROM error_logs ORDER BY timestamp DESC LIMIT ?`;
      let params: (string | number)[] = [limit];

      if (userCode) {
        query = `SELECT * FROM error_logs WHERE user_code = ? ORDER BY timestamp DESC LIMIT ?`;
        params = [userCode, limit];
      }

      const errors = await env.DB.prepare(query).bind(...params).all();
      return jsonResponse({
        count: errors.results.length,
        errors: errors.results
      });
    }

    // Health check endpoint for monitoring
    if (url.pathname === "/api/health") {
      try {
        // Test DB connection
        const dbTest = await env.DB.prepare("SELECT 1 as test").first();
        const errorCount = await env.DB.prepare(
          "SELECT COUNT(*) as count FROM error_logs WHERE timestamp > datetime('now', '-1 hour')"
        ).first();

        return jsonResponse({
          status: "healthy",
          version: "2.0.0",
          timestamp: new Date().toISOString(),
          db_status: dbTest ? "connected" : "disconnected",
          recent_errors: (errorCount?.count || 0) as number,
          mcp_endpoints: {
            sse: "/sse?code=USER_CODE",
            streamable_http: "/mcp?code=USER_CODE"
          }
        });
      } catch (error) {
        return jsonResponse({
          status: "unhealthy",
          version: "2.0.0",
          timestamp: new Date().toISOString(),
          error: String(error)
        }, 500);
      }
    }

    // Root - info
    if (url.pathname === "/") {
      return jsonResponse({
        name: "Calories Tracker MCP Server",
        version: "2.0.0",
        personal_url: "/user/{YOUR_CODE}/...",
        mcp_endpoint: "/user/{YOUR_CODE}/mcp",
        chatgpt_schema: "/user/{YOUR_CODE}/openapi.json",
        api_endpoints: ["/api/register", "/api/user", "/api/today"],
      });
    }

    // ============ PERSONAL USER ENDPOINTS ============
    // /user/{code}/... - персональные URL для каждого пользователя
    const userPathMatch = url.pathname.match(/^\/user\/([A-Za-z0-9]+)(\/.*)?$/);
    if (userPathMatch) {
      const userCode = userPathMatch[1];
      const subPath = userPathMatch[2] || '/';

      // Проверить что пользователь существует
      const userId = await getUserIdByCode(env.DB, userCode);

      // Персональная OpenAPI схема (доступна без проверки userId для discovery)
      if (subPath === '/openapi.json') {
        const baseUrl = `https://calories-mcp.icynarco112.workers.dev/user/${userCode}`;
        const openApiSchema = {
          openapi: "3.1.0",
          info: {
            title: "Calories Tracker - Personal API",
            description: `Personal API for user ${userCode}. Track meals and nutrition.`,
            version: "1.0.0"
          },
          servers: [{ url: baseUrl, description: "Personal endpoint" }],
          paths: {
            "/api/meals": {
              post: {
                operationId: "addMeal",
                summary: "Add a meal to the tracker",
                description: "Record a meal with nutritional information. Use when user wants to log food they ate.",
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        required: ["name", "calories_kcal"],
                        properties: {
                          name: { type: "string", description: "Name of the meal" },
                          calories_kcal: { type: "integer", description: "Calories in kcal" },
                          protein_g: { type: "number", description: "Protein in grams" },
                          fat_g: { type: "number", description: "Fat in grams" },
                          carbs_g: { type: "number", description: "Carbs in grams" },
                          fiber_g: { type: "number", description: "Fiber in grams" },
                          meal_type: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack", "other"] },
                          health_score: { type: "integer", minimum: 1, maximum: 10 }
                        }
                      }
                    }
                  }
                },
                responses: { "200": { description: "Meal added successfully" } }
              },
              get: {
                operationId: "getMealHistory",
                summary: "Get meal history",
                description: "Get recent meals logged by the user.",
                parameters: [{ name: "limit", in: "query", schema: { type: "integer", default: 10 }, description: "Number of meals to return" }],
                responses: { "200": { description: "List of meals" } }
              }
            },
            "/api/water": {
              post: {
                operationId: "addWater",
                summary: "Record water intake",
                description: "Record drinking water, tea, coffee, or other beverages.",
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        required: ["amount_ml"],
                        properties: {
                          amount_ml: { type: "integer", description: "Amount in milliliters" },
                          beverage_type: { type: "string", enum: ["water", "tea", "coffee", "juice", "other"], description: "Type of beverage" },
                          notes: { type: "string", description: "Optional notes" }
                        }
                      }
                    }
                  }
                },
                responses: { "200": { description: "Water intake recorded" } }
              }
            },
            "/api/activity": {
              post: {
                operationId: "addActivity",
                summary: "Record physical activity",
                description: "Record exercise or physical activity like walking, running, gym, etc.",
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        required: ["activity_type", "duration_minutes"],
                        properties: {
                          activity_type: { type: "string", enum: ["walking", "running", "cycling", "gym", "swimming", "yoga", "other"], description: "Type of activity" },
                          duration_minutes: { type: "integer", description: "Duration in minutes" },
                          intensity: { type: "string", enum: ["light", "moderate", "vigorous"], description: "Intensity level" },
                          calories_burned: { type: "integer", description: "Calories burned (optional, will be calculated if not provided)" },
                          notes: { type: "string", description: "Optional notes" }
                        }
                      }
                    }
                  }
                },
                responses: { "200": { description: "Activity recorded" } }
              },
              get: {
                operationId: "getActivityHistory",
                summary: "Get activity history",
                description: "Get recent physical activities and exercises.",
                parameters: [{ name: "limit", in: "query", schema: { type: "integer", default: 10 }, description: "Number of records" }],
                responses: { "200": { description: "Activity history" } }
              }
            },
            "/api/today": {
              get: {
                operationId: "getTodaySummary",
                summary: "Get today's nutrition summary",
                description: "Get all meals logged today with totals and remaining goals.",
                responses: { "200": { description: "Today's summary with meals and totals" } }
              }
            },
            "/api/weekly": {
              get: {
                operationId: "getWeeklySummary",
                summary: "Get weekly nutrition summary",
                description: "Get nutrition statistics for the last 7 days with daily breakdown.",
                responses: { "200": { description: "Weekly summary" } }
              }
            },
            "/api/monthly": {
              get: {
                operationId: "getMonthlySummary",
                summary: "Get monthly nutrition summary",
                description: "Get nutrition statistics for the current month.",
                responses: { "200": { description: "Monthly summary" } }
              }
            },
            "/api/profile": {
              get: {
                operationId: "getUserProfile",
                summary: "Get user profile and goals",
                description: "Get physical parameters, BMR, TDEE, and nutrition goals.",
                responses: { "200": { description: "User profile" } }
              },
              put: {
                operationId: "setUserProfile",
                summary: "Set or update user profile",
                description: "Set physical parameters and goals. This calculates BMR, TDEE, and daily calorie targets.",
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        required: ["height_cm", "current_weight", "target_weight", "birth_date", "gender", "activity_level"],
                        properties: {
                          height_cm: { type: "number", description: "Height in centimeters" },
                          current_weight: { type: "number", description: "Current weight in kg" },
                          target_weight: { type: "number", description: "Target weight in kg" },
                          birth_date: { type: "string", description: "Birth date in YYYY-MM-DD format" },
                          gender: { type: "string", enum: ["male", "female"], description: "Gender for BMR calculation" },
                          activity_level: { type: "string", enum: ["sedentary", "light", "moderate", "active", "very_active"], description: "Activity level" },
                          goal_type: { type: "string", enum: ["lose_weight", "gain_weight", "maintain"], description: "Weight goal" },
                          weight_change_rate: { type: "string", enum: ["slow", "moderate", "fast"], description: "Rate of weight change" }
                        }
                      }
                    }
                  }
                },
                responses: { "200": { description: "Profile saved" } }
              }
            },
            "/api/weight": {
              post: {
                operationId: "logWeight",
                summary: "Record current weight",
                description: "Log current weight for tracking progress over time.",
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        required: ["weight"],
                        properties: {
                          weight: { type: "number", description: "Current weight in kg" },
                          notes: { type: "string", description: "Optional notes about the measurement" }
                        }
                      }
                    }
                  }
                },
                responses: { "200": { description: "Weight recorded" } }
              },
              get: {
                operationId: "getWeightHistory",
                summary: "Get weight history",
                description: "Get weight tracking history to see progress over time.",
                parameters: [{ name: "limit", in: "query", schema: { type: "integer", default: 30 }, description: "Number of records to return" }],
                responses: { "200": { description: "Weight history with stats" } }
              }
            },
            "/api/meals/{meal_id}": {
              delete: {
                operationId: "deleteMeal",
                summary: "Delete a meal",
                description: "Delete a recorded meal by its ID. Use when user wants to remove an entry.",
                parameters: [{ name: "meal_id", in: "path", required: true, schema: { type: "integer" }, description: "ID of the meal to delete" }],
                responses: { "200": { description: "Meal deleted" }, "404": { description: "Meal not found" } }
              },
              patch: {
                operationId: "editMeal",
                summary: "Edit a meal",
                description: "Edit/update a recorded meal. Use when user wants to correct calories, name, or other details.",
                parameters: [{ name: "meal_id", in: "path", required: true, schema: { type: "integer" }, description: "ID of the meal to edit" }],
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          name: { type: "string", description: "New name for the meal" },
                          calories_kcal: { type: "integer", description: "New calorie value" },
                          protein_g: { type: "number", description: "New protein value" },
                          fat_g: { type: "number", description: "New fat value" },
                          carbs_g: { type: "number", description: "New carbs value" },
                          meal_type: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack", "other"] },
                          health_score: { type: "integer", minimum: 1, maximum: 10 },
                          notes: { type: "string", description: "New notes" }
                        }
                      }
                    }
                  }
                },
                responses: { "200": { description: "Meal updated" }, "404": { description: "Meal not found" } }
              }
            },
            "/api/meals/search": {
              get: {
                operationId: "searchMeals",
                summary: "Search meals by name",
                description: "Search through meal history by name. Use when user asks about specific food they ate before.",
                parameters: [
                  { name: "q", in: "query", required: true, schema: { type: "string" }, description: "Search query" },
                  { name: "limit", in: "query", schema: { type: "integer", default: 20 }, description: "Max results" }
                ],
                responses: { "200": { description: "Search results" } }
              }
            },
            "/api/activity/{activity_id}": {
              delete: {
                operationId: "deleteActivity",
                summary: "Delete an activity",
                description: "Delete a recorded activity/exercise by its ID.",
                parameters: [{ name: "activity_id", in: "path", required: true, schema: { type: "integer" }, description: "ID of the activity" }],
                responses: { "200": { description: "Activity deleted" }, "404": { description: "Activity not found" } }
              },
              patch: {
                operationId: "editActivity",
                summary: "Edit an activity",
                description: "Edit/update a recorded activity. Use when user wants to correct duration, calories, or type.",
                parameters: [{ name: "activity_id", in: "path", required: true, schema: { type: "integer" }, description: "ID of the activity" }],
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          activity_type: { type: "string", enum: ["walking", "running", "cycling", "gym", "swimming", "yoga", "other"] },
                          duration_minutes: { type: "integer" },
                          intensity: { type: "string", enum: ["light", "moderate", "vigorous"] },
                          calories_burned: { type: "integer" },
                          notes: { type: "string" }
                        }
                      }
                    }
                  }
                },
                responses: { "200": { description: "Activity updated" }, "404": { description: "Activity not found" } }
              }
            },
            "/api/weight/{weight_id}": {
              delete: {
                operationId: "deleteWeight",
                summary: "Delete a weight record",
                description: "Delete an incorrect weight entry by its ID.",
                parameters: [{ name: "weight_id", in: "path", required: true, schema: { type: "integer" }, description: "ID of the weight record" }],
                responses: { "200": { description: "Weight record deleted" }, "404": { description: "Record not found" } }
              }
            },
            "/api/recommendations": {
              get: {
                operationId: "getRecommendations",
                summary: "Get food recommendations",
                description: "Get personalized food recommendations based on remaining calories and macros for today.",
                responses: { "200": { description: "Recommendations with remaining goals" } }
              }
            }
          }
        };
        return new Response(JSON.stringify(openApiSchema, null, 2), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      // Для остальных endpoints нужен валидный пользователь
      if (!userId) {
        return jsonResponse({ error: "Invalid user code", code: userCode }, 404);
      }

      // POST /user/{code}/api/meals - добавить еду
      if (subPath === '/api/meals' && request.method === 'POST') {
        try {
          const body = await request.json() as Record<string, unknown>;
          const mealName = (body.meal_name || body.name || "Unknown meal") as string;
          const calories = (body.calories || body.calories_kcal || 0) as number;
          const proteins = (body.proteins || body.protein_g || 0) as number;
          const fats = (body.fats || body.fat_g || 0) as number;
          const carbs = (body.carbs || body.carbs_g || 0) as number;
          const fiber = (body.fiber || body.fiber_g || 0) as number;
          const waterMl = (body.water_ml || 0) as number;
          const mealType = (body.meal_type || "other") as string;
          const healthScore = (body.healthiness_score || body.health_score || 5) as number;
          const notes = (body.notes || null) as string | null;

          const result = await env.DB.prepare(
            `INSERT INTO meals (user_id, meal_name, calories, proteins, fats, carbs, fiber, water_ml, meal_type, healthiness_score, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(userId, mealName, calories, proteins, fats, carbs, fiber, waterMl, mealType, healthScore, notes).run();

          return jsonResponse({
            success: true,
            message: `Meal "${mealName}" added!`,
            id: result.meta.last_row_id,
            calories, proteins, fats, carbs
          });
        } catch (error) {
          return jsonResponse({ error: "Failed to add meal", details: String(error) }, 500);
        }
      }

      // GET /user/{code}/api/today - статистика за сегодня
      if (subPath === '/api/today' && request.method === 'GET') {
        const tz = getKyivOffset();
        const meals = await env.DB.prepare(
          `SELECT meal_name, calories, proteins, fats, carbs, fiber, meal_type, healthiness_score, created_at
           FROM meals WHERE user_id = ? AND date(created_at, '${tz}') = date('now', '${tz}')
           ORDER BY created_at DESC`
        ).bind(userId).all();

        const totals = await env.DB.prepare(
          `SELECT SUM(calories) as total_calories, SUM(proteins) as total_proteins,
                  SUM(fats) as total_fats, SUM(carbs) as total_carbs, COUNT(*) as meal_count
           FROM meals WHERE user_id = ? AND date(created_at, '${tz}') = date('now', '${tz}')`
        ).bind(userId).first();

        const profile = await env.DB.prepare(
          `SELECT daily_calorie_goal, protein_goal FROM user_profiles WHERE user_id = ?`
        ).bind(userId).first();

        const calorieGoal = (profile?.daily_calorie_goal || 2000) as number;
        const proteinGoal = (profile?.protein_goal || 100) as number;
        const totalCalories = (totals?.total_calories || 0) as number;

        return jsonResponse({
          date: new Date().toISOString().split('T')[0],
          meals: meals.results,
          totals: {
            calories: totalCalories,
            proteins: totals?.total_proteins || 0,
            fats: totals?.total_fats || 0,
            carbs: totals?.total_carbs || 0,
            meal_count: totals?.meal_count || 0
          },
          goals: {
            calorie_goal: calorieGoal,
            protein_goal: proteinGoal,
            calories_remaining: calorieGoal - totalCalories
          }
        });
      }

      // GET /user/{code}/api/profile - профиль пользователя
      if (subPath === '/api/profile' && request.method === 'GET') {
        const profile = await env.DB.prepare(
          `SELECT * FROM user_profiles WHERE user_id = ?`
        ).bind(userId).first();

        if (!profile) {
          return jsonResponse({ error: "Profile not set up" }, 404);
        }

        return jsonResponse({
          height_cm: profile.height_cm,
          current_weight: profile.current_weight,
          target_weight: profile.target_weight,
          goal_type: profile.goal_type,
          activity_level: profile.activity_level,
          bmr: profile.bmr,
          tdee: profile.tdee,
          daily_calorie_goal: profile.daily_calorie_goal,
          protein_goal: profile.protein_goal
        });
      }

      // PUT /user/{code}/api/profile - настроить профиль
      if (subPath === '/api/profile' && request.method === 'PUT') {
        try {
          const body = await request.json() as Record<string, unknown>;
          const heightCm = body.height_cm as number;
          const currentWeight = body.current_weight as number;
          const targetWeight = body.target_weight as number;
          const birthDate = body.birth_date as string;
          const gender = body.gender as string;
          const activityLevel = body.activity_level as string;
          const goalType = (body.goal_type || 'lose_weight') as string;
          const weightChangeRate = (body.weight_change_rate || 'moderate') as string;

          const age = calculateAge(birthDate);
          const bmr = calculateBMR(currentWeight, heightCm, age, gender as 'male' | 'female');
          const tdee = calculateTDEE(bmr, activityLevel as 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active');
          const dailyGoal = calculateDailyGoal(tdee, weightChangeRate as 'slow' | 'moderate' | 'fast', goalType as 'lose_weight' | 'gain_weight' | 'maintain');
          const proteinGoal = calculateProteinGoal(targetWeight);

          await env.DB.prepare(
            `INSERT INTO user_profiles (user_id, height_cm, current_weight, target_weight, birth_date, gender, activity_level, bmr, tdee, daily_calorie_goal, protein_goal, weight_loss_rate, goal_type, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(user_id) DO UPDATE SET
               height_cm = excluded.height_cm, current_weight = excluded.current_weight, target_weight = excluded.target_weight,
               birth_date = excluded.birth_date, gender = excluded.gender, activity_level = excluded.activity_level,
               bmr = excluded.bmr, tdee = excluded.tdee, daily_calorie_goal = excluded.daily_calorie_goal,
               protein_goal = excluded.protein_goal, weight_loss_rate = excluded.weight_loss_rate, goal_type = excluded.goal_type, updated_at = datetime('now')`
          ).bind(userId, heightCm, currentWeight, targetWeight, birthDate, gender, activityLevel, bmr, tdee, dailyGoal, proteinGoal, weightChangeRate, goalType).run();

          return jsonResponse({
            success: true,
            message: "Profile saved!",
            profile: { height_cm: heightCm, current_weight: currentWeight, target_weight: targetWeight, age, bmr, tdee, daily_calorie_goal: dailyGoal, protein_goal: proteinGoal }
          });
        } catch (error) {
          return jsonResponse({ error: "Failed to save profile", details: String(error) }, 500);
        }
      }

      // GET /user/{code}/api/meals - история еды
      if (subPath === '/api/meals' && request.method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '10');
        const meals = await env.DB.prepare(
          `SELECT id, meal_name, calories, proteins, fats, carbs, fiber, water_ml, meal_type, healthiness_score, notes, created_at
           FROM meals WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
        ).bind(userId, limit).all();

        return jsonResponse({ count: meals.results.length, meals: meals.results });
      }

      // DELETE /user/{code}/api/meals/{id} - удалить еду
      const deleteMatch = subPath.match(/^\/api\/meals\/(\d+)$/);
      if (deleteMatch && request.method === 'DELETE') {
        const mealId = parseInt(deleteMatch[1]);
        const meal = await env.DB.prepare(
          "SELECT id, meal_name FROM meals WHERE id = ? AND user_id = ?"
        ).bind(mealId, userId).first();

        if (!meal) {
          return jsonResponse({ error: "Meal not found", meal_id: mealId }, 404);
        }

        await env.DB.prepare("DELETE FROM meals WHERE id = ? AND user_id = ?").bind(mealId, userId).run();
        return jsonResponse({ success: true, message: `Meal "${meal.meal_name}" deleted`, deleted_id: mealId });
      }

      // PATCH /user/{code}/api/meals/{id} - редактировать еду
      const patchMatch = subPath.match(/^\/api\/meals\/(\d+)$/);
      if (patchMatch && request.method === 'PATCH') {
        try {
          const mealId = parseInt(patchMatch[1]);
          const meal = await env.DB.prepare(
            "SELECT * FROM meals WHERE id = ? AND user_id = ?"
          ).bind(mealId, userId).first();

          if (!meal) {
            return jsonResponse({ error: "Meal not found", meal_id: mealId }, 404);
          }

          const body = await request.json() as Record<string, unknown>;
          const updates: string[] = [];
          const values: unknown[] = [];

          if (body.name !== undefined || body.meal_name !== undefined) {
            updates.push("meal_name = ?"); values.push(body.name || body.meal_name);
          }
          if (body.calories !== undefined || body.calories_kcal !== undefined) {
            updates.push("calories = ?"); values.push(body.calories || body.calories_kcal);
          }
          if (body.proteins !== undefined || body.protein_g !== undefined) {
            updates.push("proteins = ?"); values.push(body.proteins || body.protein_g);
          }
          if (body.fats !== undefined || body.fat_g !== undefined) {
            updates.push("fats = ?"); values.push(body.fats || body.fat_g);
          }
          if (body.carbs !== undefined || body.carbs_g !== undefined) {
            updates.push("carbs = ?"); values.push(body.carbs || body.carbs_g);
          }
          if (body.fiber !== undefined || body.fiber_g !== undefined) {
            updates.push("fiber = ?"); values.push(body.fiber || body.fiber_g);
          }
          if (body.meal_type !== undefined) { updates.push("meal_type = ?"); values.push(body.meal_type); }
          if (body.health_score !== undefined || body.healthiness_score !== undefined) {
            updates.push("healthiness_score = ?"); values.push(body.health_score || body.healthiness_score);
          }
          if (body.notes !== undefined) { updates.push("notes = ?"); values.push(body.notes); }

          if (updates.length === 0) {
            return jsonResponse({ error: "No fields to update" }, 400);
          }

          values.push(mealId, userId);
          await env.DB.prepare(`UPDATE meals SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`).bind(...values).run();

          const updated = await env.DB.prepare("SELECT * FROM meals WHERE id = ?").bind(mealId).first();
          return jsonResponse({ success: true, message: "Meal updated", meal: updated });
        } catch (error) {
          return jsonResponse({ error: "Failed to update meal", details: String(error) }, 500);
        }
      }

      // POST /user/{code}/api/water - записать воду
      if (subPath === '/api/water' && request.method === 'POST') {
        try {
          const body = await request.json() as Record<string, unknown>;
          const amountMl = (body.amount_ml || 250) as number;
          const beverageType = (body.beverage_type || 'water') as string;
          const notes = body.notes as string | null;

          const beverageNames: Record<string, string> = { water: 'Вода', tea: 'Чай', coffee: 'Кофе', juice: 'Сок', other: 'Напиток' };
          const calories = beverageType === 'juice' ? Math.round(amountMl * 0.4) : 0;

          const result = await env.DB.prepare(
            `INSERT INTO meals (user_id, meal_name, calories, proteins, fats, carbs, fiber, water_ml, meal_type, healthiness_score, notes)
             VALUES (?, ?, ?, 0, 0, 0, 0, ?, 'other', ?, ?)`
          ).bind(userId, `${beverageNames[beverageType] || 'Напиток'} ${amountMl}мл`, calories, amountMl, beverageType === 'water' ? 10 : 8, notes || null).run();

          return jsonResponse({ success: true, message: `Recorded ${amountMl}ml of ${beverageType}`, id: result.meta.last_row_id, amount_ml: amountMl });
        } catch (error) {
          return jsonResponse({ error: "Failed to add water", details: String(error) }, 500);
        }
      }

      // POST /user/{code}/api/activity - записать активность
      if (subPath === '/api/activity' && request.method === 'POST') {
        try {
          const body = await request.json() as Record<string, unknown>;
          const activityType = (body.activity_type || 'other') as string;
          const durationMinutes = (body.duration_minutes || 30) as number;
          const intensity = (body.intensity || 'moderate') as string;
          let caloriesBurned = body.calories_burned as number | undefined;
          const description = body.description as string | null;
          const notes = body.notes as string | null;

          if (!caloriesBurned) {
            const profile = await env.DB.prepare("SELECT current_weight FROM user_profiles WHERE user_id = ?").bind(userId).first();
            const weight = (profile?.current_weight as number) || 70;
            const met = metValues[activityType]?.[intensity] || 5.0;
            caloriesBurned = Math.round((met * weight * durationMinutes) / 60);
          }

          const result = await env.DB.prepare(
            `INSERT INTO activities (user_id, activity_type, duration_minutes, intensity, calories_burned, description, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).bind(userId, activityType, durationMinutes, intensity, caloriesBurned, description || null, notes || null).run();

          const activityNames: Record<string, string> = { walking: 'Ходьба', running: 'Бег', cycling: 'Велосипед', gym: 'Тренажёрный зал', swimming: 'Плавание', yoga: 'Йога', other: 'Активность' };

          return jsonResponse({
            success: true,
            message: `${activityNames[activityType] || 'Активность'}: ${durationMinutes} мин, ${caloriesBurned} ккал`,
            id: result.meta.last_row_id, activity_type: activityType, duration_minutes: durationMinutes, calories_burned: caloriesBurned
          });
        } catch (error) {
          return jsonResponse({ error: "Failed to add activity", details: String(error) }, 500);
        }
      }

      // GET /user/{code}/api/weekly - статистика за неделю
      if (subPath === '/api/weekly' && request.method === 'GET') {
        const tz = getKyivOffset();
        const dailyStats = await env.DB.prepare(
          `SELECT date(created_at, '${tz}') as date, COUNT(*) as meal_count, SUM(calories) as total_calories,
                  SUM(proteins) as total_proteins, SUM(fats) as total_fats, SUM(carbs) as total_carbs
           FROM meals WHERE user_id = ? AND date(created_at, '${tz}') >= date('now', '${tz}', '-7 days')
           GROUP BY date(created_at, '${tz}') ORDER BY date DESC`
        ).bind(userId).all();

        const weekTotal = await env.DB.prepare(
          `SELECT COUNT(*) as meal_count, SUM(calories) as total_calories, AVG(calories) as avg_daily_calories,
                  SUM(proteins) as total_proteins, SUM(fats) as total_fats, SUM(carbs) as total_carbs
           FROM meals WHERE user_id = ? AND date(created_at, '${tz}') >= date('now', '${tz}', '-7 days')`
        ).bind(userId).first();

        return jsonResponse({ period: "Last 7 days", total: weekTotal, daily_breakdown: dailyStats.results });
      }

      // GET /user/{code}/api/monthly - статистика за месяц
      if (subPath === '/api/monthly' && request.method === 'GET') {
        const tz = getKyivOffset();
        const monthStats = await env.DB.prepare(
          `SELECT COUNT(*) as meal_count, SUM(calories) as total_calories, AVG(calories) as avg_calories_per_meal,
                  SUM(proteins) as total_proteins, SUM(fats) as total_fats, SUM(carbs) as total_carbs,
                  COUNT(DISTINCT date(created_at, '${tz}')) as days_tracked
           FROM meals WHERE user_id = ? AND strftime('%Y-%m', created_at, '${tz}') = strftime('%Y-%m', 'now', '${tz}')`
        ).bind(userId).first();

        return jsonResponse({ period: new Date().toISOString().slice(0, 7), summary: monthStats });
      }

      // POST /user/{code}/api/weight - записать вес
      if (subPath === '/api/weight' && request.method === 'POST') {
        try {
          const body = await request.json() as Record<string, unknown>;
          const weight = body.weight as number;
          const notes = body.notes as string | null;

          await env.DB.prepare(`INSERT INTO weight_history (user_id, weight, notes) VALUES (?, ?, ?)`).bind(userId, weight, notes || null).run();
          await env.DB.prepare(`UPDATE user_profiles SET current_weight = ?, updated_at = datetime('now') WHERE user_id = ?`).bind(weight, userId).run();

          const previousWeight = await env.DB.prepare(
            `SELECT weight FROM weight_history WHERE user_id = ? ORDER BY recorded_at DESC LIMIT 1 OFFSET 1`
          ).bind(userId).first();
          const change = previousWeight ? weight - (previousWeight.weight as number) : 0;

          return jsonResponse({ success: true, message: `Weight ${weight}kg recorded`, weight, change: change ? (change > 0 ? `+${change.toFixed(1)}` : change.toFixed(1)) : null });
        } catch (error) {
          return jsonResponse({ error: "Failed to log weight", details: String(error) }, 500);
        }
      }

      // GET /user/{code}/api/weight - история веса
      if (subPath === '/api/weight' && request.method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '30');
        const tz = getKyivOffset();
        const history = await env.DB.prepare(
          `SELECT weight, notes, datetime(recorded_at, '${tz}') as recorded_at FROM weight_history
           WHERE user_id = ? ORDER BY recorded_at DESC LIMIT ?`
        ).bind(userId, limit).all();

        const profile = await env.DB.prepare(`SELECT target_weight, current_weight FROM user_profiles WHERE user_id = ?`).bind(userId).first();
        const weights = history.results.map(r => r.weight as number);

        return jsonResponse({
          history: history.results,
          stats: {
            records_count: history.results.length,
            current_weight: profile?.current_weight,
            target_weight: profile?.target_weight,
            min_weight: weights.length > 0 ? Math.min(...weights) : null,
            max_weight: weights.length > 0 ? Math.max(...weights) : null,
            total_change: weights.length >= 2 ? weights[0] - weights[weights.length - 1] : 0
          }
        });
      }

      // GET /user/{code}/api/activity - история активностей
      if (subPath === '/api/activity' && request.method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '10');
        const tz = getKyivOffset();
        const activities = await env.DB.prepare(
          `SELECT id, activity_type, duration_minutes, intensity, calories_burned, description, notes,
                  datetime(created_at, '${tz}') as created_at
           FROM activities WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
        ).bind(userId, limit).all();

        const totalBurned = await env.DB.prepare(
          `SELECT SUM(calories_burned) as total FROM activities
           WHERE user_id = ? AND date(created_at, '${tz}') = date('now', '${tz}')`
        ).bind(userId).first();

        return jsonResponse({
          count: activities.results.length,
          today_calories_burned: totalBurned?.total || 0,
          activities: activities.results
        });
      }

      // DELETE /user/{code}/api/activity/{id} - удалить активность
      const deleteActivityMatch = subPath.match(/^\/api\/activity\/(\d+)$/);
      if (deleteActivityMatch && request.method === 'DELETE') {
        const activityId = parseInt(deleteActivityMatch[1]);
        const activity = await env.DB.prepare(
          "SELECT id, activity_type, duration_minutes FROM activities WHERE id = ? AND user_id = ?"
        ).bind(activityId, userId).first();

        if (!activity) {
          return jsonResponse({ error: "Activity not found", activity_id: activityId }, 404);
        }

        await env.DB.prepare("DELETE FROM activities WHERE id = ? AND user_id = ?").bind(activityId, userId).run();
        return jsonResponse({
          success: true,
          message: `Activity "${activity.activity_type}" (${activity.duration_minutes} min) deleted`,
          deleted_id: activityId
        });
      }

      // PATCH /user/{code}/api/activity/{id} - редактировать активность
      const patchActivityMatch = subPath.match(/^\/api\/activity\/(\d+)$/);
      if (patchActivityMatch && request.method === 'PATCH') {
        try {
          const activityId = parseInt(patchActivityMatch[1]);
          const activity = await env.DB.prepare(
            "SELECT * FROM activities WHERE id = ? AND user_id = ?"
          ).bind(activityId, userId).first();

          if (!activity) {
            return jsonResponse({ error: "Activity not found", activity_id: activityId }, 404);
          }

          const body = await request.json() as Record<string, unknown>;
          const updates: string[] = [];
          const values: unknown[] = [];

          if (body.activity_type !== undefined) { updates.push("activity_type = ?"); values.push(body.activity_type); }
          if (body.duration_minutes !== undefined) { updates.push("duration_minutes = ?"); values.push(body.duration_minutes); }
          if (body.intensity !== undefined) { updates.push("intensity = ?"); values.push(body.intensity); }
          if (body.calories_burned !== undefined) { updates.push("calories_burned = ?"); values.push(body.calories_burned); }
          if (body.description !== undefined) { updates.push("description = ?"); values.push(body.description); }
          if (body.notes !== undefined) { updates.push("notes = ?"); values.push(body.notes); }

          if (updates.length === 0) {
            return jsonResponse({ error: "No fields to update" }, 400);
          }

          values.push(activityId, userId);
          await env.DB.prepare(`UPDATE activities SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`).bind(...values).run();

          const updated = await env.DB.prepare("SELECT * FROM activities WHERE id = ?").bind(activityId).first();
          return jsonResponse({ success: true, message: "Activity updated", activity: updated });
        } catch (error) {
          return jsonResponse({ error: "Failed to update activity", details: String(error) }, 500);
        }
      }

      // GET /user/{code}/api/meals/search?q=... - поиск еды
      if (subPath === '/api/meals/search' && request.method === 'GET') {
        const query = url.searchParams.get('q') || '';
        const limit = parseInt(url.searchParams.get('limit') || '20');

        if (!query) {
          return jsonResponse({ error: "Missing search query parameter 'q'" }, 400);
        }

        const meals = await env.DB.prepare(
          `SELECT id, meal_name, calories, proteins, fats, carbs, meal_type, created_at
           FROM meals WHERE user_id = ? AND meal_name LIKE ? ORDER BY created_at DESC LIMIT ?`
        ).bind(userId, `%${query}%`, limit).all();

        return jsonResponse({ query, count: meals.results.length, meals: meals.results });
      }

      // DELETE /user/{code}/api/weight/{id} - удалить запись веса
      const deleteWeightMatch = subPath.match(/^\/api\/weight\/(\d+)$/);
      if (deleteWeightMatch && request.method === 'DELETE') {
        const weightId = parseInt(deleteWeightMatch[1]);
        const weightRecord = await env.DB.prepare(
          "SELECT id, weight FROM weight_history WHERE id = ? AND user_id = ?"
        ).bind(weightId, userId).first();

        if (!weightRecord) {
          return jsonResponse({ error: "Weight record not found", weight_id: weightId }, 404);
        }

        await env.DB.prepare("DELETE FROM weight_history WHERE id = ? AND user_id = ?").bind(weightId, userId).run();
        return jsonResponse({
          success: true,
          message: `Weight record ${weightRecord.weight}kg deleted`,
          deleted_id: weightId
        });
      }

      // GET /user/{code}/api/recommendations - рекомендации
      if (subPath === '/api/recommendations' && request.method === 'GET') {
        const profile = await env.DB.prepare(
          "SELECT daily_calorie_goal, protein_goal FROM user_profiles WHERE user_id = ?"
        ).bind(userId).first();

        if (!profile) {
          return jsonResponse({ error: "Profile not set up. Use set_user_profile first." }, 404);
        }

        const tz = getKyivOffset();
        const today = await env.DB.prepare(
          `SELECT COALESCE(SUM(calories), 0) as calories, COALESCE(SUM(proteins), 0) as proteins,
                  COALESCE(SUM(fats), 0) as fats, COALESCE(SUM(carbs), 0) as carbs
           FROM meals WHERE user_id = ? AND date(created_at, '${tz}') = date('now', '${tz}')`
        ).bind(userId).first();

        const calorieGoal = profile.daily_calorie_goal as number;
        const proteinGoal = profile.protein_goal as number;
        const caloriesEaten = (today?.calories || 0) as number;
        const proteinEaten = (today?.proteins || 0) as number;
        const caloriesLeft = calorieGoal - caloriesEaten;
        const proteinLeft = proteinGoal - proteinEaten;

        let recommendations: string[] = [];
        if (caloriesLeft <= 0) {
          recommendations.push("Дневной лимит калорий достигнут. Рекомендуется не есть больше или выбрать очень лёгкие продукты.");
        } else if (caloriesLeft < 200) {
          recommendations.push(`Осталось мало калорий (${caloriesLeft} ккал). Подойдут: овощной салат, огурцы, зелёный чай.`);
        } else if (proteinLeft > 20) {
          recommendations.push(`Нужно добрать белок (${Math.round(proteinLeft)}г). Подойдут: куриная грудка, творог, яйца, рыба.`);
        } else if (caloriesLeft > 500) {
          recommendations.push(`Ещё можно съесть полноценный приём пищи (~${caloriesLeft} ккал).`);
        } else {
          recommendations.push(`Осталось ${caloriesLeft} ккал. Подойдёт лёгкий перекус или небольшой ужин.`);
        }

        return jsonResponse({
          remaining: { calories: caloriesLeft, protein: Math.round(proteinLeft) },
          eaten_today: { calories: caloriesEaten, protein: Math.round(proteinEaten) },
          goals: { calories: calorieGoal, protein: proteinGoal },
          recommendations
        });
      }

      // /user/{code}/sse - MCP SSE для Claude
      if (subPath.startsWith('/sse')) {
        // Перенаправляем на стандартный SSE handler с code
        url.pathname = subPath;
        url.searchParams.set("code", userCode);
        if (!url.searchParams.has("sessionId")) {
          url.searchParams.set("sessionId", userCode);
        }
        const modifiedRequest = new Request(url.toString(), request);
        const ctxWithProps = { ...ctx, props: { userCode } };
        return CaloriesMCP.serveSSE("/sse").fetch(modifiedRequest, env, ctxWithProps);
      }

      // /user/{code}/mcp - unified MCP endpoint (Streamable HTTP + SSE)
      if (subPath.startsWith('/mcp')) {
        const useSse = request.method === "GET" || wantsEventStream(request);
        url.pathname = useSse ? "/sse" : "/mcp";
        url.searchParams.set("code", userCode);
        if (!url.searchParams.has("sessionId")) {
          url.searchParams.set("sessionId", userCode);
        }
        const modifiedRequest = new Request(url.toString(), request);
        const ctxWithProps = { ...ctx, props: { userCode } };
        if (useSse) {
          return CaloriesMCP.serveSSE("/sse").fetch(modifiedRequest, env, ctxWithProps);
        }
        return CaloriesMCP.serve("/mcp").fetch(modifiedRequest, env, ctxWithProps);
      }

      return jsonResponse({ error: "Unknown endpoint", path: subPath }, 404);
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

    // GET /openapi.json - OpenAPI schema for ChatGPT Actions
    if (url.pathname === "/openapi.json" || url.pathname === "/.well-known/openapi.json") {
      const openApiSchema = {
        openapi: "3.1.0",
        info: {
          title: "Calories Tracker API",
          description: "API for tracking meals and nutrition. Use your personal code from Telegram bot for authentication.",
          version: "1.0.0"
        },
        servers: [{ url: "https://calories-mcp.icynarco112.workers.dev", description: "Production server" }],
        paths: {
          "/api/chatgpt/meals": {
            post: {
              operationId: "addMeal",
              summary: "Add a meal to the tracker",
              description: "Record a meal with its nutritional information",
              parameters: [{
                name: "code", in: "query", required: true,
                schema: { type: "string" },
                description: "User authentication code from Telegram bot"
              }],
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["name", "calories_kcal"],
                      properties: {
                        name: { type: "string", description: "Name of the meal" },
                        calories_kcal: { type: "integer", description: "Calories in kcal" },
                        protein_g: { type: "number", description: "Protein in grams" },
                        fat_g: { type: "number", description: "Fat in grams" },
                        carbs_g: { type: "number", description: "Carbs in grams" },
                        fiber_g: { type: "number", description: "Fiber in grams" },
                        meal_type: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack", "other"] },
                        health_score: { type: "integer", minimum: 1, maximum: 10 }
                      }
                    }
                  }
                }
              },
              responses: {
                "200": { description: "Meal added successfully" },
                "400": { description: "Bad request" },
                "404": { description: "User not found" }
              }
            }
          },
          "/api/chatgpt/today": {
            get: {
              operationId: "getTodaySummary",
              summary: "Get today's nutrition summary",
              description: "Get all meals logged today and totals",
              parameters: [{
                name: "code", in: "query", required: true,
                schema: { type: "string" },
                description: "User authentication code"
              }],
              responses: { "200": { description: "Today's summary" } }
            }
          },
          "/api/chatgpt/profile": {
            get: {
              operationId: "getUserProfile",
              summary: "Get user profile and goals",
              parameters: [{
                name: "code", in: "query", required: true,
                schema: { type: "string" },
                description: "User authentication code"
              }],
              responses: { "200": { description: "User profile" } }
            }
          }
        }
      };
      return new Response(JSON.stringify(openApiSchema, null, 2), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
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

      try {
        const tz = getKyivOffset();
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
           WHERE user_id = ? AND date(created_at, '${tz}') = date('now', '${tz}')`
        ).bind(userId).first();

        const meals = await env.DB.prepare(
          `SELECT id, meal_name, calories, proteins, fats, carbs, meal_type, healthiness_score,
                  strftime('%H:%M', created_at, '${tz}') as time
           FROM meals
           WHERE user_id = ? AND date(created_at, '${tz}') = date('now', '${tz}')
           ORDER BY created_at DESC`
        ).bind(userId).all();

        return jsonResponse({
          date: new Date().toISOString().split("T")[0],
          summary,
          meals: meals.results,
        });
      } catch (error) {
        console.error("Database error in /api/today:", error);
        return jsonResponse({ error: "Database error", details: String(error) }, 500);
      }
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

      try {
        const tz = getKyivOffset();
        const dailyStats = await env.DB.prepare(
          `SELECT
            date(created_at, '${tz}') as date,
            COUNT(*) as meal_count,
            SUM(calories) as total_calories,
            SUM(proteins) as total_proteins,
            SUM(fats) as total_fats,
            SUM(carbs) as total_carbs,
            SUM(water_ml) as total_water,
            AVG(healthiness_score) as avg_healthiness
           FROM meals
           WHERE user_id = ? AND date(created_at, '${tz}') >= date('now', '${tz}', '-7 days')
           GROUP BY date(created_at, '${tz}')
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
           WHERE user_id = ? AND date(created_at, '${tz}') >= date('now', '${tz}', '-7 days')`
        ).bind(userId).first();

        // Get weekly activities
        const weekActivities = await env.DB.prepare(
          `SELECT
            COUNT(*) as activity_count,
            SUM(duration_minutes) as total_duration,
            SUM(calories_burned) as total_burned
           FROM activities
           WHERE user_id = ? AND date(created_at, '${tz}') >= date('now', '${tz}', '-7 days')`
        ).bind(userId).first();

        return jsonResponse({
          period: "Last 7 days",
          total: weekTotal,
          daily_breakdown: dailyStats.results,
          activities: {
            count: weekActivities?.activity_count || 0,
            total_duration: weekActivities?.total_duration || 0,
            total_burned: weekActivities?.total_burned || 0
          }
        });
      } catch (error) {
        console.error("Database error in /api/week:", error);
        return jsonResponse({ error: "Database error", details: String(error) }, 500);
      }
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
      const tz = getKyivOffset();
      const avgCalories = await env.DB.prepare(
        `SELECT AVG(daily_total) as avg_cal, COUNT(*) as days_count FROM (
          SELECT SUM(calories) as daily_total
          FROM meals
          WHERE user_id = ? AND date(created_at, '${tz}') >= date('now', '${tz}', '-7 days')
          GROUP BY date(created_at, '${tz}')
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

      const tz = getKyivOffset();
      const history = await env.DB.prepare(
        `SELECT weight, notes, datetime(recorded_at, '${tz}') as recorded_at
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

      try {
        const tz = getKyivOffset();
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
            COUNT(DISTINCT date(created_at, '${tz}')) as days_tracked
           FROM meals
           WHERE user_id = ? AND strftime('%Y-%m', created_at, '${tz}') = strftime('%Y-%m', 'now', '${tz}')`
        ).bind(userId).first();

        // Get monthly activities
        const monthActivities = await env.DB.prepare(
          `SELECT
            COUNT(*) as activity_count,
            SUM(duration_minutes) as total_duration,
            SUM(calories_burned) as total_burned
           FROM activities
           WHERE user_id = ? AND strftime('%Y-%m', created_at, '${tz}') = strftime('%Y-%m', 'now', '${tz}')`
        ).bind(userId).first();

        return jsonResponse({
          period: new Date().toISOString().slice(0, 7),
          summary: monthStats,
          activities: {
            count: monthActivities?.activity_count || 0,
            total_duration: monthActivities?.total_duration || 0,
            total_burned: monthActivities?.total_burned || 0
          }
        });
      } catch (error) {
        console.error("Database error in /api/month:", error);
        return jsonResponse({ error: "Database error", details: String(error) }, 500);
      }
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

      const tz = getKyivOffset();
      const activities = await env.DB.prepare(
        `SELECT id, activity_type, duration_minutes, intensity, calories_burned, description,
                strftime('%H:%M', created_at, '${tz}') as time
         FROM activities
         WHERE user_id = ? AND date(created_at, '${tz}') = date('now', '${tz}')
         ORDER BY created_at DESC`
      ).bind(userId).all();

      const totals = await env.DB.prepare(
        `SELECT
          COUNT(*) as activity_count,
          COALESCE(SUM(duration_minutes), 0) as total_duration,
          COALESCE(SUM(calories_burned), 0) as total_burned
         FROM activities
         WHERE user_id = ? AND date(created_at, '${tz}') = date('now', '${tz}')`
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
      const tz = getKyivOffset();
      const todayData = await env.DB.prepare(
        `SELECT meal_name, calories, proteins, fats, carbs,
                strftime('%H:%M', created_at, '${tz}') as time
         FROM meals
         WHERE user_id = ? AND date(created_at, '${tz}') = date('now', '${tz}')
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
         AND insight_date = date('now', '${tz}', '-1 day')
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
      const tz = getKyivOffset();
      const weekData = await env.DB.prepare(
        `SELECT
          date(created_at, '${tz}') as date,
          SUM(calories) as total_calories,
          SUM(proteins) as total_proteins,
          SUM(fats) as total_fats,
          SUM(carbs) as total_carbs,
          COUNT(*) as meal_count
         FROM meals
         WHERE user_id = ? AND date(created_at, '${tz}') >= date('now', '${tz}', '-7 days')
         GROUP BY date(created_at, '${tz}')
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
      const tz = getKyivOffset();
      const monthStats = await env.DB.prepare(
        `SELECT
          COUNT(*) as meal_count,
          SUM(calories) as total_calories,
          SUM(proteins) as total_proteins,
          SUM(fats) as total_fats,
          SUM(carbs) as total_carbs,
          AVG(healthiness_score) as avg_healthiness,
          COUNT(DISTINCT date(created_at, '${tz}')) as days_tracked
         FROM meals
         WHERE user_id = ? AND strftime('%Y-%m', created_at, '${tz}') = strftime('%Y-%m', 'now', '${tz}')`
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

      // Get first tracking day this month to calculate tracking percentage
      const firstDay = await env.DB.prepare(
        `SELECT MIN(date(created_at, '${tz}')) as first_date
         FROM meals
         WHERE user_id = ? AND strftime('%Y-%m', created_at, '${tz}') = strftime('%Y-%m', 'now', '${tz}')`
      ).bind(userId).first();

      const firstDate = firstDay?.first_date as string;
      // Calculate days since first tracking (not since month start)
      const today = new Date();
      const firstTrackingDate = firstDate ? new Date(firstDate) : today;
      const daysSinceStart = Math.ceil((today.getTime() - firstTrackingDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
      const trackingPercent = Math.round((daysTracked / daysSinceStart) * 100);

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
        `SELECT weight, date(recorded_at, '${tz}') as date
         FROM weight_history
         WHERE user_id = ? AND strftime('%Y-%m', recorded_at, '${tz}') = strftime('%Y-%m', 'now', '${tz}')
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
Дней отслеживания: ${daysTracked} из ${daysSinceStart} возможных (${trackingPercent}% дисциплина)
Первый день записи: ${firstDate || 'неизвестно'}
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
      const tz = getKyivOffset();
      const weekData = await env.DB.prepare(
        `SELECT
          date(created_at, '${tz}') as date,
          SUM(calories) as total_calories,
          SUM(proteins) as total_proteins,
          COUNT(*) as meal_count,
          AVG(healthiness_score) as avg_health
         FROM meals
         WHERE user_id = ? AND date(created_at, '${tz}') >= date('now', '${tz}', '-7 days')
         GROUP BY date(created_at, '${tz}')
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
      const tz = getKyivOffset();
      const dailyStats = await env.DB.prepare(
        `SELECT
          date(created_at, '${tz}') as day,
          SUM(calories) as total_cal,
          SUM(proteins) as total_protein,
          SUM(fats) as total_fat,
          SUM(carbs) as total_carbs,
          COUNT(*) as meal_count
        FROM meals
        WHERE user_id = ? AND date(created_at, '${tz}') >= date('now', '${tz}', '-14 days')
        GROUP BY date(created_at, '${tz}')
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

    // ============ REST API FOR CHATGPT ============
    // These endpoints work with ?code=USER_CODE for authentication
    // ChatGPT Actions will use these instead of MCP

    // POST /api/chatgpt/meals - Add a meal (ChatGPT compatible)
    if (url.pathname === "/api/chatgpt/meals" && request.method === "POST") {
      const userCode = url.searchParams.get("code");
      if (!userCode) {
        return jsonResponse({ error: "code parameter required" }, 400);
      }

      const userId = await getUserIdByCode(env.DB, userCode);
      if (!userId) {
        return jsonResponse({ error: "User not found. Register via Telegram bot first." }, 404);
      }

      try {
        const body = await request.json() as Record<string, unknown>;

        // Support both standard and ChatGPT parameter names
        const mealName = (body.meal_name || body.name || "Unknown meal") as string;
        const calories = (body.calories || body.calories_kcal || 0) as number;
        const proteins = (body.proteins || body.protein_g || 0) as number;
        const fats = (body.fats || body.fat_g || 0) as number;
        const carbs = (body.carbs || body.carbs_g || 0) as number;
        const fiber = (body.fiber || body.fiber_g || 0) as number;
        const waterMl = (body.water_ml || 0) as number;
        const mealType = (body.meal_type || "other") as string;
        const healthScore = (body.healthiness_score || body.health_score || 5) as number;
        const notes = (body.notes || null) as string | null;

        // Check for duplicate
        const recentDuplicate = await env.DB.prepare(
          `SELECT id FROM meals WHERE user_id = ? AND meal_name = ? AND calories BETWEEN ? AND ? AND created_at > datetime('now', '-3 minutes') LIMIT 1`
        ).bind(userId, mealName, Math.floor(calories * 0.9), Math.ceil(calories * 1.1)).first();

        if (recentDuplicate) {
          return jsonResponse({
            success: true,
            message: `Meal "${mealName}" already recorded recently`,
            duplicate: true,
            id: recentDuplicate.id
          });
        }

        const result = await env.DB.prepare(
          `INSERT INTO meals (user_id, meal_name, calories, proteins, fats, carbs, fiber, water_ml, meal_type, healthiness_score, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(userId, mealName, calories, proteins, fats, carbs, fiber, waterMl, mealType, healthScore, notes).run();

        return jsonResponse({
          success: true,
          message: `Meal "${mealName}" added successfully!`,
          id: result.meta.last_row_id,
          calories: calories,
          proteins: proteins,
          fats: fats,
          carbs: carbs
        });
      } catch (error) {
        console.error("Error adding meal:", error);
        return jsonResponse({ error: "Failed to add meal", details: String(error) }, 500);
      }
    }

    // GET /api/chatgpt/today - Get today's summary (ChatGPT compatible)
    if (url.pathname === "/api/chatgpt/today" && request.method === "GET") {
      const userCode = url.searchParams.get("code");
      if (!userCode) {
        return jsonResponse({ error: "code parameter required" }, 400);
      }

      try {
        const userId = await getUserIdByCode(env.DB, userCode);
        if (!userId) {
          return jsonResponse({ error: "User not found" }, 404);
        }

        const tz = getKyivOffset();
        const meals = await env.DB.prepare(
          `SELECT meal_name, calories, proteins, fats, carbs, fiber, meal_type, healthiness_score, created_at
           FROM meals WHERE user_id = ? AND date(created_at, '${tz}') = date('now', '${tz}')
           ORDER BY created_at DESC`
        ).bind(userId).all();

        const totals = await env.DB.prepare(
          `SELECT SUM(calories) as total_calories, SUM(proteins) as total_proteins,
                  SUM(fats) as total_fats, SUM(carbs) as total_carbs, SUM(fiber) as total_fiber,
                  COUNT(*) as meal_count
           FROM meals WHERE user_id = ? AND date(created_at, '${tz}') = date('now', '${tz}')`
        ).bind(userId).first();

        const profile = await env.DB.prepare(
          `SELECT daily_calorie_goal, protein_goal FROM user_profiles WHERE user_id = ?`
        ).bind(userId).first();

        const calorieGoal = (profile?.daily_calorie_goal || 2000) as number;
        const proteinGoal = (profile?.protein_goal || 100) as number;
        const totalCalories = (totals?.total_calories || 0) as number;
        const totalProteins = (totals?.total_proteins || 0) as number;

        return jsonResponse({
          date: new Date().toISOString().split('T')[0],
          meals: meals.results,
          totals: {
            calories: totalCalories,
            proteins: totalProteins,
            fats: totals?.total_fats || 0,
            carbs: totals?.total_carbs || 0,
            fiber: totals?.total_fiber || 0,
            meal_count: totals?.meal_count || 0
          },
          goals: {
            calorie_goal: calorieGoal,
            protein_goal: proteinGoal,
            calories_remaining: calorieGoal - totalCalories,
            protein_remaining: proteinGoal - totalProteins
          }
        });
      } catch (error) {
        console.error("[ChatGPT API] /api/chatgpt/today error:", error);
        await logError(env.DB, "chatgpt_today", error, userCode, null, { endpoint: "/api/chatgpt/today" });
        return jsonResponse({ error: "Failed to get today summary", details: String(error) }, 500);
      }
    }

    // GET /api/chatgpt/profile - Get user profile (ChatGPT compatible)
    if (url.pathname === "/api/chatgpt/profile" && request.method === "GET") {
      const userCode = url.searchParams.get("code");
      if (!userCode) {
        return jsonResponse({ error: "code parameter required" }, 400);
      }

      try {
        const userId = await getUserIdByCode(env.DB, userCode);
        if (!userId) {
          return jsonResponse({ error: "User not found" }, 404);
        }

        const profile = await env.DB.prepare(
          `SELECT * FROM user_profiles WHERE user_id = ?`
        ).bind(userId).first();

        if (!profile) {
          return jsonResponse({ error: "Profile not set up" }, 404);
        }

        return jsonResponse({
          height_cm: profile.height_cm,
          current_weight: profile.current_weight,
          target_weight: profile.target_weight,
          goal_type: profile.goal_type,
          activity_level: profile.activity_level,
          bmr: profile.bmr,
          tdee: profile.tdee,
          daily_calorie_goal: profile.daily_calorie_goal,
          protein_goal: profile.protein_goal
        });
      } catch (error) {
        console.error("[ChatGPT API] /api/chatgpt/profile error:", error);
        await logError(env.DB, "chatgpt_profile", error, userCode, null, { endpoint: "/api/chatgpt/profile" });
        return jsonResponse({ error: "Failed to get profile", details: String(error) }, 500);
      }
    }

    // GET /api/chatgpt/tools - List available tools for ChatGPT (OpenAPI discovery)
    if (url.pathname === "/api/chatgpt/tools" && request.method === "GET") {
      return jsonResponse({
        tools: [
          { name: "add_meal", endpoint: "POST /api/chatgpt/meals", description: "Add a meal to the tracker" },
          { name: "get_today", endpoint: "GET /api/chatgpt/today", description: "Get today's nutrition summary" },
          { name: "get_profile", endpoint: "GET /api/chatgpt/profile", description: "Get user profile and goals" }
        ],
        auth: "Pass user code as ?code=USER_CODE query parameter"
      });
    }

    // ============ MCP ENDPOINTS ============

    // MCP SSE endpoint with user code
    // Pass userCode through props since serveSSE() rewrites the URL
    // Use userCode as sessionId to ensure stable Durable Object for each user
    if (url.pathname.startsWith("/sse")) {
      const userCode = url.searchParams.get("code");

      // Add sessionId=code to URL for stable DO (fixes ChatGPT "Resource not found" issue)
      if (userCode && !url.searchParams.has("sessionId")) {
        url.searchParams.set("sessionId", userCode);
      }

      const modifiedRequest = new Request(url.toString(), request);
      const ctxWithProps = { ...ctx, props: { userCode } };
      return CaloriesMCP.serveSSE("/sse").fetch(modifiedRequest, env, ctxWithProps);
    }

    // MCP Streamable HTTP endpoint
    // Also use userCode as session identifier for stability
    if (url.pathname.startsWith("/mcp")) {
      const userCode = url.searchParams.get("code");
      const ctxWithProps = { ...ctx, props: { userCode } };
      console.log(`[MCP] /mcp request, userCode: ${userCode}`);
      return CaloriesMCP.serve("/mcp").fetch(request, env, ctxWithProps);
    }

    return new Response("Not Found", { status: 404 });
  },
};
