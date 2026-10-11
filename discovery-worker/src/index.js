// Phase 1: 24/7 bounty discovery. Runs every minute (Cloudflare cron),
// searches GitHub for bounty-labelled issues, dedupes in D1, alerts Telegram.
// Triage: `-linked:pr` skips issues that already have a linked pull request
// (someone is already working on them), so alerts are only for open races.

const QUERIES = [
  'label:"💎 Bounty" state:open is:issue no:assignee -linked:pr',
  'label:bounty state:open is:issue no:assignee -linked:pr',
  'label:bounties state:open is:issue no:assignee -linked:pr',
];

const MAX_ALERTS_PER_RUN = 10;

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(poll(env));
  },

  // Health check: GET / shows how many bounties have been seen.
  async fetch(_req, env) {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS total, MAX(first_seen) AS last_seen FROM seen"
    ).first();
    return Response.json({ ok: true, ...row });
  },
};

async function poll(env) {
  const maxAgeMs = Number(env.MAX_AGE_HOURS || 6) * 3600 * 1000;
  let alerts = 0;

  for (const q of QUERIES) {
    let items;
    try {
      items = await searchIssues(q, env);
    } catch (e) {
      console.error(`search failed (${q}): ${e.message}`);
      continue;
    }

    for (const it of items) {
      if (it.pull_request) continue;
      const repo = it.repository_url.replace("https://api.github.com/repos/", "");
      const amount = extractAmount(it);

      const ins = await env.DB.prepare(
        "INSERT OR IGNORE INTO seen (issue_id, repo, number, url, title, amount, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(it.id, repo, it.number, it.html_url, it.title, amount, it.created_at).run();

      if (!ins.meta.changes) continue; // already seen

      const fresh = Date.now() - Date.parse(it.created_at) <= maxAgeMs;
      if (!fresh || alerts >= MAX_ALERTS_PER_RUN) continue; // old backlog: store silently

      try {
        await notify(env, { repo, it, amount });
        await env.DB.prepare("UPDATE seen SET notified = 1 WHERE issue_id = ?").bind(it.id).run();
        alerts++;
      } catch (e) {
        console.error(`telegram failed: ${e.message}`);
        // forget it so the next minute retries
        await env.DB.prepare("DELETE FROM seen WHERE issue_id = ?").bind(it.id).run();
      }
    }
  }
}

async function searchIssues(q, env) {
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=30`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bounty-discovery-worker",
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const data = await res.json();
  return data.items || [];
}

function extractAmount(it) {
  const labels = (it.labels || []).map((l) => l.name).join(" ");
  const text = `${labels} ${it.title} ${(it.body || "").slice(0, 2000)}`;
  const m = text.match(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)/);
  return m ? `$${m[1]}` : null;
}

async function notify(env, { repo, it, amount }) {
  const labels = (it.labels || []).map((l) => l.name).slice(0, 6).join(", ");
  const text = [
    "🆕 NEW BOUNTY DETECTED",
    "",
    `📌 ${it.title}`,
    `📦 ${repo} #${it.number}`,
    `💰 ${amount || "amount not found"}`,
    labels ? `🏷 ${labels}` : "",
    `💬 Comments: ${it.comments}`,
    "✅ No linked PR yet",
    `🕐 Created: ${it.created_at}`,
  ].filter(Boolean).join("\n");

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: "🔗 Open issue", url: it.html_url }]] },
    }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}`);
}
