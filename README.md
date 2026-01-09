# Calories Tracker

Отслеживание калорий через Claude + Telegram отчёты.

## Архитектура

```
Claude (фото) → MCP Server → PostgreSQL → Telegram Bot (отчёты)
                    ↑
            Cloudflare Tunnel (HTTPS)
```

## Быстрый старт

### 1. Подготовка

**Создай Telegram бота:**
1. Напиши @BotFather в Telegram
2. `/newbot` → выбери имя
3. Скопируй токен бота

**Получи свой Chat ID:**
1. Напиши @userinfobot
2. Скопируй свой ID

### 2. Настройка Cloudflare Tunnel

На сервере:
```bash
# Установи cloudflared
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb

# Авторизуйся
cloudflared tunnel login

# Создай туннель
cloudflared tunnel create calories-tracker

# Получи токен
cloudflared tunnel token calories-tracker
```

### 3. Создай .env файл

```bash
cp .env.example .env
nano .env
```

Заполни:
- `POSTGRES_PASSWORD` — придумай пароль
- `TELEGRAM_BOT_TOKEN` — токен от @BotFather
- `TELEGRAM_CHAT_ID` — твой ID
- `CLOUDFLARE_TUNNEL_TOKEN` — токен туннеля

### 4. Деплой

```bash
node deploy-calories-tracker.js
```

### 5. Настрой Cloudflare Tunnel

В dashboard.cloudflare.com:
1. Zero Trust → Networks → Tunnels
2. Выбери `calories-tracker`
3. Configure → Public Hostname
4. Добавь: `calories.your-tunnel-id.trycloudflare.com` → `http://mcp-server:8787`

### 6. Добавь Connector в Claude

1. claude.ai → Settings → Connectors
2. "Add custom connector"
3. Name: `Calories Tracker`
4. URL: `https://calories.your-tunnel-id.trycloudflare.com/sse`
5. Add

### 7. Создай Claude Project

1. claude.ai → Projects → Create
2. Name: `Calories Tracker`
3. Custom Instructions: см. `claude_project_instructions.md`
4. Integrations: выбери свой connector
5. Save

## Использование

1. Открой проект в Claude
2. Отправь фото еды
3. Claude проанализирует и запишет
4. Telegram бот пришлёт отчёты по расписанию

## Команды Telegram бота

- `/today` — статистика за сегодня
- `/week` — за неделю
- `/month` — за месяц

## Структура проекта

```
calories-tracker/
├── docker-compose.yml
├── .env
├── mcp_server/
│   ├── main.py          # FastAPI + MCP
│   ├── tools.py         # Инструменты
│   ├── models.py        # Модели БД
│   └── database.py      # Подключение к БД
└── telegram_bot/
    ├── bot.py           # Telegram бот
    └── reports.py       # Генерация отчётов
```

## Troubleshooting

**Бот не отправляет сообщения:**
- Проверь TELEGRAM_CHAT_ID
- Напиши боту `/start`

**Claude не видит connector:**
- Проверь что Cloudflare Tunnel работает
- Проверь URL в настройках connector

**Данные не сохраняются:**
- Проверь логи: `docker-compose logs mcp-server`
- Проверь подключение к БД
