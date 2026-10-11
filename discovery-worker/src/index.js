// 24/7 bounty discovery. Runs every minute (Cloudflare cron).
// Sources: GitHub issue search (bounty labels) + Algora public API.
// Dedupes in D1, alerts Telegram.
// Triage: `-linked:pr` skips GitHub issues that already have a linked pull request.

const QUERIES = [
  'label:"💎 Bounty" state:open is:issue no:assignee -linked:pr',
  'label:bounty state:open is:issue no:assignee -linked:pr',
  'label:bounties state:open is:issue no:assignee -linked:pr',
];

const ALGORA_URL = "https://console.algora.io/api/trpc/bounty.list";
const MAX_ALERTS_PER_RUN = 10;

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(poll(env));
  },

  async fetch(req, env) {
    const u = new URL(req.url);

    // Debug: shows what the Algora API returns (public data only).
    if (u.pathname === "/debug/algora") {
      try {
        const items = await fetchAlgora();
        return Response.json({ ok: true, count: items.length, sample: items.slice(0, 2) });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 502 });
      }
    }

    // Health check: how many bounties have been seen.
    const gh = await env.DB.prepare(
      "SELECT COUNT(*) AS total, MAX(first_seen) AS last_seen FROM seen"
    ).first();
    const ext = await env.DB.prepare(
      "SELECT COUNT(*) AS total, MAX(first_seen) AS last_seen FROM seen_ext"
    ).first();
    return Response.json({ ok: true, github: gh, algora: ext });
  },
};

async function poll(env) {
  const maxAgeMs = Number(env.MAX_AGE_HOURS || 6) * 3600 * 1000;
  const budget = { alerts: 0 };

  try {
    await pollGitHub(env, maxAgeMs, budget);
  } catch (e) {
    console.error(`github poll crashed: ${e.message}`);
  }
  try {
    await pollAlgora(env, maxAgeMs, budget);
  } catch (e) {
    console.error(`algora poll crashed: ${e.message}`);
  }
}

// ------------------------------------------------------------------ GitHub
async function pollGitHub(env, maxAgeMs, budget) {
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

      // Already alerted via Algora? Don't alert twice.
      const dup = await env.DB.prepare("SELECT 1 FROM seen_ext WHERE url = ?").bind(it.html_url).first();
      if (dup) continue;

      const fresh = Date.now() - Date.parse(it.created_at) <= maxAgeMs;
      if (!fresh || budget.alerts >= MAX_ALERTS_PER_RUN) continue; // old backlog: store silently

      const labels = (it.labels || []).map((l) => l.name).slice(0, 6).join(", ");
      const text = [
        "🆕 NEW BOUNTY DETECTED (GitHub)",
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
        budget.alerts++;
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

// ------------------------------------------------------------------ Algora
// Algora's public (legacy tRPC) endpoint. The response shape is not documented,
// so we accept the common tRPC / plain shapes and fail safely.
async function fetchAlgora() {
  const params = { limit: 50, status: "active" };
  const attempts = [
    `${ALGORA_URL}?input=${encodeURIComponent(JSON.stringify({ json: params }))}`,
    `${ALGORA_URL}?input=${encodeURIComponent(JSON.stringify(params))}`,
  ];
  let lastErr = "no response";
  for (const url of attempts) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "bounty-discovery-worker" },
      });
      if (!res.ok) {
        lastErr = `Algora ${res.status}`;
        continue;
      }
      const data = await res.json();
      const body = data?.result?.data?.json ?? data?.result?.data ?? data;
      if (Array.isArray(body?.items)) return body.items;
      lastErr = "unexpected response shape";
    } catch (e) {
      lastErr = e.message;
    }
  }
  throw new Error(lastErr);
}

function algoraAmount(b) {
  if (b.reward_formatted) return String(b.reward_formatted);
  if (typeof b.amount === "number") {
    const cur = b.currency || "USD";
    const major = (b.amount / 100).toLocaleString("en-US");
    return cur === "USD" ? `$${major}` : `${major} ${cur}`;
  }
  return null;
}

async function pollAlgora(env, maxAgeMs, budget) {
  let items;
  try {
    items = await fetchAlgora();
  } catch (e) {
    console.error(`algora failed: ${e.message}`);
    return;
  }

  for (const b of items) {
    const task = b.task || {};
    const url = task.html_url || task.url;
    if (!b.id || !url) continue;

    const repo = task.repo_owner && task.repo_name ? `${task.repo_owner}/${task.repo_name}` : task.repo_name || "";
    const title = task.title || `${repo} #${task.number ?? ""}`.trim();
    const amount = algoraAmount(b);
    const created = b.created_at || null;

    const ins = await env.DB.prepare(
      "INSERT OR IGNORE INTO seen_ext (key, source, repo, number, url, title, amount, created_at) VALUES (?, 'algora', ?, ?, ?, ?, ?, ?)"
    ).bind(`algora:${b.id}`, repo, task.number ?? null, url, title, amount, created).run();

    if (!ins.meta.changes) continue; // already seen

    // Already alerted via the GitHub search? Don't alert twice.
    const dup = await env.DB.prepare("SELECT 1 FROM seen WHERE url = ?").bind(url).first();
    if (dup) continue;

    const fresh = created ? Date.now() - Date.parse(created) <= maxAgeMs : false;
    if (!fresh || budget.alerts >= MAX_ALERTS_PER_RUN) continue; // old backlog: store silently

    const text = [
      "🆕 NEW BOUNTY DETECTED (Algora)",
      "",
      `📌 ${title}`,
      repo ? `📦 ${repo}${task.number ? ` #${task.number}` : ""}` : "",
      `💰 ${amount || "amount not found"}`,
      b.org?.handle ? `🏢 ${b.org.handle}` : "",
      `🕐 Created: ${created}`,
    ].filter(Boolean).join("\n");

    try {
      await sendTelegram(env, text, url);
      await env.DB.prepare("UPDATE seen_ext SET notified = 1 WHERE key = ?").bind(`algora:${b.id}`).run();
      budget.alerts++;
    } catch (e) {
      console.error(`telegram failed: ${e.message}`);
      await env.DB.prepare("DELETE FROM seen_ext WHERE key = ?").bind(`algora:${b.id}`).run();
    }
  }
}

// ---------------------------------------------------------------- Telegram
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
