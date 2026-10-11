# Bounty discovery worker (Phase 1)

Polls GitHub every minute for open, unassigned issues labelled `💎 Bounty`, `bounty` or `bounties`,
dedupes them in Cloudflare D1 and sends new ones to Telegram.

The D1 database `bounty-discovery` and its table already exist (see `schema.sql`).

## Deploy

```bash
cd discovery-worker
npx wrangler login
npx wrangler secret put GH_TOKEN             # fine-grained PAT, public repos read-only is enough
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler deploy
```

Check: open the worker URL, it returns `{ok:true,total,last_seen}`.
Logs: `npx wrangler tail`.

## Behaviour

- First run stores the existing backlog silently; only issues created in the last `MAX_AGE_HOURS` (6) alert.
- At most 10 alerts per minute. A failed Telegram send is retried next minute.
- GitHub search allows 30 requests/min when authenticated; this uses 3.
