# Bayt

A private household PWA for three people: two parents and a nanny. It has a shared
shopping list (items are removed automatically 48 hours after they are ticked), tasks,
a chat, and web push notifications.

## Stack

- Cloudflare Worker (Hono) serving static assets
- D1 database (`DB`, named `bayt`, migrations in `migrations/`)
- Durable Object `Household` for realtime chat
- Daily cron for cleanup
- Vite + vite-plugin-pwa frontend, Vitest for tests

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply bayt --local
npm run dev
```

Then open http://localhost:8787.

## First-time deploy

1. `npx wrangler d1 create bayt`, then paste the returned id into `wrangler.jsonc`.
2. `npx wrangler secret put SETUP_CODE`
3. `npx wrangler d1 migrations apply bayt --remote`
4. `npm run deploy`

The GitHub Actions workflow (`.github/workflows/deploy.yml`) runs typecheck, tests and
build on every push and PR, and on pushes to `main` applies migrations and deploys. It needs
the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## First use

1. Open the deployed URL in Chrome on your phone.
2. Enter the setup code and your name.
3. In Settings, use **Invite parent** / **Invite nanny** and share the link.
4. Install the app from the Chrome menu: **Install app**.
5. Enable notifications in Settings.

## Configuration

Change `VAPID_SUBJECT` in `src/lib/push.ts` to your own `mailto:` address or site URL.

## Tests

```sh
npm test
```

## Icons

PNG icons are generated from the SVGs in `public/icons/` with `tools/make-icons.mjs`.
See the comment at the top of that file for the exact commands (`@resvg/resvg-js` is
deliberately not a project dependency).

## Credits

- Ideas and patterns from [cloudflare/workers-chat-demo](https://github.com/cloudflare/workers-chat-demo) (BSD-3-Clause)
- [vite-plugin-pwa](https://github.com/vite-pwa/vite-pwa) (MIT)
- The author's Sila app
- UX ideas only (no code) from KitchenOwl and Donetick (AGPL)
