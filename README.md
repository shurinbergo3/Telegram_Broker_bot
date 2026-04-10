# Bizwell Sell Bot

A Telegram bot that monitors a designated group for Russian company listings (identified by INN), analyzes them against a buyer database using Google Gemini AI, and automatically replies with matching buyers or a "no buyers found" verdict.

## How It Works

1. A message containing a company INN (10–12 digits) is posted in the target Telegram group.
2. The bot extracts company details and runs an AI analysis using a configurable prompt.
3. Gemini compares the company's region, age, tax system (SNO), OKVED, revenue, address, and price against active buyer requests.
4. The bot replies in-thread with matched buyers or a "no buyers found" message.
5. Companies with **Статус: Ядро** are fast-tracked — no AI call, immediate "no buyers / send to ads" reply.

## Features

- **AI matching** via Google Gemini (model configurable via `AI_MODEL` env var)
- **External webhook** — `POST /incoming` accepts messages from other bots
- **Admin panel** via `/admin` command with inline keyboard:
  - View stats (user count, analysis count)
  - List registered users
  - View last-hour event log
  - Edit system prompt (upload `.txt` file)
  - Manage sub-admins (super-admin only)
- **Multi-admin support** — super-admin + additional admins stored in `data.json`
- **Retry on startup** — 10 attempts with exponential backoff
- **In-memory log buffer** — last 100 events, filterable by last hour

## Stack

| Layer | Tech |
|---|---|
| Bot framework | [Telegraf](https://telegraf.js.org/) v4 |
| AI | Google Gemini (`@google/generative-ai`) |
| HTTP server | Express v5 |
| Storage | JSON files (`data.json`, `settings.json`) |
| Runtime | Node.js (CommonJS) |

## Setup

### 1. Clone & install

```bash
git clone <repo-url>
cd Bizwell_Sell_Bot
npm install
```

### 2. Configure environment

Create a `.env` file:

```env
TELEGRAM_BOT_TOKEN=your_bot_token
GEMINI_API_KEY=your_gemini_api_key
TELEGRAM_GROUP_ID=-100123456789
ADMIN_ID=123456789
AI_MODEL=gemini-2.0-flash-lite          # optional, default: gemini-3.1-flash-lite-preview
WEBHOOK_SECRET=your_secret_token        # optional but recommended
PORT=3001                               # optional, default: 3001
```

### 3. Initialize data files

Ensure `data.json` exists:

```json
{
  "users": [],
  "analysesCount": 0,
  "admins": []
}
```

Ensure `settings.json` exists with a `promptTemplate` field (edit via `/admin` → Edit Prompt).

### 4. Run

```bash
npm start
```

## Webhook API

External bots can push company listings directly:

```
POST /incoming
Headers:
  x-secret: <WEBHOOK_SECRET>
  Content-Type: application/json

Body:
{
  "text": "<full company listing text containing INN>",
  "messageId": 12345
}
```

The bot will analyze the text and reply to `messageId` in the target group.

## Bot Commands

| Command | Who | Description |
|---|---|---|
| `/admin` | Admins | Open admin panel |
| `/cancel` | Admins | Cancel pending input (prompt edit / new admin) |
| `/myid` | Anyone | Show chat ID and user ID |

## File Structure

```
├── index.js        # Bot logic, handlers, HTTP server
├── db.js           # JSON file read/write helpers
├── data.json       # Users, analyses count, sub-admins
├── settings.json   # AI system prompt template
├── package.json
└── .env            # Secrets (not committed)
```

## Prompt Editing

The AI system prompt is stored in `settings.json` under `promptTemplate`. It supports two placeholders:

- `{{now}}` / `{{TODAY}}` — replaced with today's date (`DD.MM.YYYY`) at runtime

To update the prompt: `/admin` → **Edit Prompt** → download the `.txt` file → edit → send back.
