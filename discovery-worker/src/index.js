// 24/7 bounty discovery. Runs every minute (Cloudflare cron).
// Searches GitHub for open, unassigned issues that carry a bounty and have no
// linked pull request yet, dedupes them in D1 and alerts Telegram.
//
// Sources (all via GitHub search):
//   - issues labelled "💎 Bounty" (Algora), "bounty", "bounties"
//   - issues where the BountyHub bot left its "Bounty Alert" comment
// `-linked:pr` skips issues that already have a linked pull request.

const SOURCES = [
  { name: "GitHub", sort: "created", ageField: "created_at", q: 'label:"💎 Bounty" state:open is:issue no:assignee -linked:pr' },
  { name: "GitHub", sort: "created", ageField: "created_at", q: "label:bounty state:open is:issue no:assignee -linked:pr" },
  { name: "GitHub", sort: "created", ageField: "created_at", q: "label:bounties state:open is:issue no:assignee -linked:pr" },
  // The BountyHub bot comments on the issue when a bounty is created, which can
  // be long after the issue itself was opened, so we watch recent activity.
  { name: "BountyHub", sort: "updated", ageField: "updated_at", q: '"BountyHub" "Bounty Alert" in:comments state:open is:issue no:assignee -linked:pr' },
];

const MAX_ALERTS_PER_RUN = 10;

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(poll(env));
  },

  // Health check: how many bounties have been seen.
  async fetch(_req, env) {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS total, SUM(notified) AS alerted, MAX(first_seen) AS last_seen FROM seen"
    ).first();
    return Response.json({ ok: true, ...row });
  },
};

async function poll(env) {
  const maxAgeMs = Number(env.MAX_AGE_HOURS || 6) * 3600 * 1000;
  let alerts = 0;
  let failed = 0;

  for (const src of SOURCES) {
    let items;
    try {
      items = await searchIssues(src, env);
    } catch (e) {
      failed++;
      console.error(`search failed (${src.name}): ${e.message}`);
      continue;
    }

    for (const it of items) {
      if (it.pull_request) continue;
      const repo = it.repository_url.replace("https://api.github.com/repos/", "");

      const ins = await env.DB.prepare(
        "INSERT OR IGNORE INTO seen (issue_id, repo, number, url, title, amount, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(it.id, repo, it.number, it.html_url, it.title, null, it.created_at).run();

      if (!ins.meta.changes) continue; // already seen

      const fresh = Date.now() - Date.parse(it[src.ageField]) <= maxAgeMs;
      if (!fresh || alerts >= MAX_ALERTS_PER_RUN) continue; // old backlog: store silently

      let amount = extractAmount(it);
      if (!amount && src.name === "BountyHub") amount = await bountyHubAmount(it, env);
      if (amount) {
        await env.DB.prepare("UPDATE seen SET amount = ? WHERE issue_id = ?").bind(amount, it.id).run();
      }

      const labels = (it.labels || []).map((l) => l.name).slice(0, 6).join(", ");
      const text = [
        `🆕 NEW BOUNTY DETECTED (${src.name})`,
        "",
        `📌 ${it.title}`,
        `📦 ${repo} #${it.number}`,
        `💰 ${amount || "amount not found"}`,
        labels ? `🏷 ${labels}` : "",
        `💬 Comments: ${it.comments}`,
        "✅ No linked PR yet",
        `🕐 Created: ${it.created_at}`,
      ].filter(Boolean).join("\n");

      try {
        await sendTelegram(env, text, it.html_url);
        await env.DB.prepare("UPDATE seen SET notified = 1 WHERE issue_id = ?").bind(it.id).run();
        alerts++;
      } catch (e) {
        console.error(`telegram failed: ${e.message}`);
        // forget it so the next minute retries
        await env.DB.prepare("DELETE FROM seen WHERE issue_id = ?").bind(it.id).run();
      }
    }
  }

  if (failed === SOURCES.length) {
    console.error("ALL searches failed - check GH_TOKEN (expired or revoked?)");
  }
}

async function ghFetch(url, env) {
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bounty-discovery-worker",
    },
  });
}

async function searchIssues(src, env) {
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(src.q)}&sort=${src.sort}&order=desc&per_page=30`;
  const res = await ghFetch(url, env);
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

// The BountyHub bot writes: "A bounty of $10.00 has been created by ..."
async function bountyHubAmount(it, env) {
  try {
    const res = await ghFetch(`${it.comments_url}?per_page=15`, env);
    if (!res.ok) return null;
    const comments = await res.json();
    for (const c of comments) {
      if (!/bountyhub/i.test(c.user?.login || "")) continue;
      const m = (c.body || "").match(/bounty of\W*\$\s?([\d,]+(?:\.\d+)?)/i);
      if (m) return `$${m[1]}`;
    }
  } catch (_e) {
    // amount is optional
  }
  return null;
}

async function sendTelegram(env, text, url) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: "🔗 Open issue", url }]] },
    }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}`);
}
