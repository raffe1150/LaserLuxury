# Netlify Deployment Instructions

To deploy this Application and the Telegram Bot Webhook to Netlify as a serverless function, follow this folder structure:

```
your-project-folder/
├── netlify/
│   └── functions/
│       └── telegram-webhook.ts    <-- The serverless function code
├── src/                           <-- Your React UI source files
├── public/
├── package.json
├── vite.config.ts
└── netlify.toml                   <-- Netlify configuration file
```

## 1. Create `netlify.toml`
Create a `netlify.toml` in your project root to instruct Netlify where to build things:
```toml
[build]
  command = "npm run build"
  publish = "dist"

[functions]
  node_bundler = "esbuild"
```

## 2. Dependencies
Ensure you install the Netlify functions module in your project:
`npm install @netlify/functions`

## 3. Environment Variables
In your Netlify Dashboard (Site Settings > Environment Variables), you **must** configure these variables:
- `TELEGRAM_BOT_TOKEN`
- `GEMINI_API_KEY`
- `SYSTEM_PROMPT`
*(Note: Since Netlify functions don't share memory with the Frontend React app, the secrets entered in the frontend "sandbox" won't automatically sync to the deployed Netlify function. Enter them securely in your Netlify dashboard instead).*

## 4. Webhook Setup
After deploying, Netlify will host your function at:
`https://your-site-name.netlify.app/.netlify/functions/telegram-webhook`

To link it to your Telegram bot, simply open your browser and go to:
`https://api.telegram.org/bot<YOUR_TELEGRAM_BOT_TOKEN>/setWebhook?url=https://your-site-name.netlify.app/.netlify/functions/telegram-webhook`

*(Replace the URL and Token with your real ones)*.
