// 24/7 bounty discovery. Runs every minute (Cloudflare cron).
// Searches GitHub for open, unassigned issues that carry a bounty and have no
// linked pull request yet, keeps only the kinds of work the coding agent is good
// at (language / keyword / size rules below; the bounty amount does not matter),
// asks an LLM to double-check, dedupes in D1 and alerts Telegram.
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

// ---- What the coding agent is good at (edit these lists to taste) ----
// Repo primary language must be one of these (docs-only issues pass in any repo).
const ALLOWED_LANGS = ["Python", "JavaScript", "TypeScript", "HTML", "CSS", "SCSS", "Vue", "Markdown"];
// Matches are shown in the alert; they do not decide anything on their own.
const POSITIVE_KEYWORDS = [
  "frontend", "front-end", "ui", "tailwind", "component", "components", "redesign",
  "bug", "fix", "error", "script", "automation",
  "test", "tests", "unit test", "coverage", "refactor",
  "documentation", "docs", "readme", "typo",
  "react", "vue", "fastify", "flask", "fastapi", "pytest", "jest",
];
// Out of scope: heavy DB migrations / Prisma schemas, "build everything from scratch".
const NEGATIVE_PATTERNS = [
  /\bprisma\b/i,
  /\b(db|database|sql)[ -]migrations?\b/i,
  /\bmigrations?\b.{0,40}\b(database|postgres|mysql|sql)\b/i,
  /\bfrom scratch\b/i,
  /\bfull[- ]?stack\b.{0,30}\b(saas|platform|app|application)\b/i,
  /\b(entire|whole|complete) (platform|system|saas)\b/i,
];
const DOCS_RE = /\b(docs?|documentation|readme|typo|typos|spelling|changelog)\b/i;

const MAX_ALERTS_PER_RUN = 10;
const MAX_AI_CALLS_PER_RUN = 6;
const MAX_BRIEFS_PER_RUN = 3;

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(poll(env));
  },

  async fetch(req, env) {
    const u = new URL(req.url);

    // Debug: one tiny OpenRouter call per triage model to check key / model / credits.
    if (u.pathname === "/debug/ai") return debugAi(env);

    // Health check: how many bounties have been seen.
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS total, SUM(notified) AS alerted, MAX(first_seen) AS last_seen FROM seen"
    ).first();
    return Response.json({ ok: true, ai_filter: Boolean(env.OPENROUTER_API_KEY), ...row });
  },
};

async function poll(env) {
  const maxAgeMs = Number(env.MAX_AGE_HOURS || 6) * 3600 * 1000;
  const minScore = Number(env.MIN_AI_SCORE || 6);
  const minUsd = Number(env.MIN_BOUNTY_USD || 0);
  const maxUsd = Number(env.MAX_BOUNTY_USD || 1e9);
  const allowUnknown = String(env.ALERT_UNKNOWN_AMOUNT || "true") === "true";
  const maxFiles = Number(env.MAX_FILES || 12);
  const repoCache = new Map();
  let alerts = 0;
  let aiCalls = 0;
  let briefs = 0;
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

      // ---- Category filter: language, scope, keywords ----
      const info = await repoInfo(repo, env, repoCache);
      const gate = categoryGate(it, info);
      if (!gate.ok) {
        await env.DB.prepare("UPDATE seen SET ai_reason = ? WHERE issue_id = ?").bind(`skip: ${gate.why}`, it.id).run();
        continue;
      }

      // ---- Bounty amount (shown in the alert; range is optional, see vars) ----
      const amount = await findAmount(it, env);
      if (amount) {
        await env.DB.prepare("UPDATE seen SET amount = ? WHERE issue_id = ?").bind(amount, it.id).run();
      }
      const usd = parseUsd(amount);
      if (usd === null ? !allowUnknown : usd < minUsd || usd > maxUsd) continue; // wrong size

      // ---- AI feasibility filter (skipped if no OPENROUTER_API_KEY) ----
      let ai = null;
      let aiErr = "";
      if (env.OPENROUTER_API_KEY) {
        if (aiCalls >= MAX_AI_CALLS_PER_RUN) {
          // too many this minute: forget it so the next run triages it
          await env.DB.prepare("DELETE FROM seen WHERE issue_id = ?").bind(it.id).run();
          continue;
        }
        aiCalls++;
        const res = await aiTriage(env, it, repo);
        if (res && !res.error) ai = res;
        else aiErr = res?.error || "unreadable reply";
        if (ai) {
          await env.DB.prepare("UPDATE seen SET ai_score = ?, ai_reason = ? WHERE issue_id = ?")
            .bind(ai.score, ai.reason, it.id).run();
          if (ai.score < minScore || ai.verdict === "skip" || ai.ai_policy === "forbids") continue; // not a fit
          if (ai.est_files !== null && ai.est_files > maxFiles) continue; // too many files to change
        }
      }

      const labels = (it.labels || []).map((l) => l.name).slice(0, 6).join(", ");
      const text = [
        `🆕 NEW BOUNTY DETECTED (${src.name})`,
        "",
        `📌 ${it.title}`,
        `📦 ${repo} #${it.number}`,
        `💰 ${amount || "amount not found - check before you start"}`,
        gate.language ? `🧩 Language: ${gate.language}` : "",
        gate.matched.length ? `🎯 Match: ${gate.matched.join(", ")}` : "",
        labels ? `🏷 ${labels}` : "",
        `💬 Comments: ${it.comments}`,
        "✅ No linked PR yet",
        ai
          ? `🤖 AI fit: ${ai.score}/10 (~${ai.effort_hours}h${ai.est_files !== null ? `, ~${ai.est_files} files` : ""}) - ${ai.reason}`
          : env.OPENROUTER_API_KEY ? `🤖 AI fit: check unavailable (${aiErr.slice(0, 120)})` : "",
        ai && ai.ai_policy === "unknown" ? "" : ai ? `📜 AI policy: ${ai.ai_policy}` : "",
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
        continue;
      }

      // Send a brief (requirements + repo rules + prompt for claude.ai + PR checklist).
      // A failure here never affects the alert above.
      if (briefs < MAX_BRIEFS_PER_RUN) {
        briefs++;
        try {
          const brief = await buildBrief(env, it, repo, amount, ai);
          await sendDocument(
            env,
            `bounty-${repo.replace("/", "_")}-${it.number}.md`,
            brief,
            "📎 Brief: requirements, repo rules, a ready prompt for claude.ai and a PR checklist. Review and adapt everything yourself."
          );
        } catch (e) {
          console.error(`brief failed: ${e.message}`);
        }
      }
    }
  }

  if (failed === SOURCES.length) {
    console.error("ALL searches failed - check GH_TOKEN (expired or revoked?)");
  }
}

// ------------------------------------------------------------ AI triage
const TRIAGE_SYSTEM = `You triage open-source bounty issues for an autonomous coding agent.
The agent is a Claude model with a checkout of the repository, a shell and the repo's test runner.
It cannot use a browser or GUI, has no accounts, credentials, hardware, wallets or private services,
and cannot talk to the maintainers. A human reviews and edits every result before a PR is sent.

The agent works best on: Python, JavaScript, TypeScript, HTML/CSS, Markdown; React, Vue, Tailwind,
Fastify, Flask, FastAPI, Pytest, Jest; bug fixes, UI/frontend work, scripts and automation, tests,
refactors, docs. Single-file or small multi-file changes are ideal. Rate LOW (0-3) anything that needs
more than about 12 files, a full-stack build from scratch, a large architecture change, heavy database
migrations (SQL, Prisma schemas), or low-level code (Rust, C, C++, Go).

Rate how likely the agent is to produce a correct, mergeable, reviewable solution:
- 9-10: small, clear, testable (bug fix, small feature, docs, tests, refactor with clear spec).
- 6-8: moderate size or needs some judgement, but requirements are clear enough.
- 3-5: vague, large, design/UX-heavy, needs visual judgement, many moving parts or unclear acceptance criteria.
- 0-2: needs hardware, credentials, on-chain deployment, external services, research, a product decision, or is not a coding task.
Also report the maintainers' stance on AI-written code if the issue text states one:
"forbids" (explicitly no AI-generated code), "allows" (explicitly fine), otherwise "unknown".

Reply with ONLY a JSON object:
{"score": <0-10 integer>, "effort_hours": <number>, "est_files": <integer, files likely to change>, "verdict": "solvable"|"borderline"|"skip", "ai_policy": "forbids"|"allows"|"unknown", "reason": "<max 140 chars>"}`;

// TRIAGE_MODEL may be a comma-separated list; the next one is tried when a model fails.
function triageModels(env) {
  return (env.TRIAGE_MODEL || "openai/gpt-oss-120b:free,openrouter/free")
    .split(",").map((m) => m.trim()).filter(Boolean);
}

async function openRouter(env, model, body) {
  return fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    // reasoning models spend part of max_tokens on thinking, so keep it generous
    body: JSON.stringify({ model, temperature: 0, reasoning: { effort: "low" }, ...body }),
    signal: AbortSignal.timeout(25000),
  });
}

async function aiTriage(env, it, repo) {
  const labels = (it.labels || []).map((l) => l.name).join(", ");
  const user = [
    `Repository: ${repo}`,
    `Title: ${it.title}`,
    `Labels: ${labels || "none"}`,
    `Comments on the issue: ${it.comments}`,
    "",
    "Issue body:",
    (it.body || "(empty)").slice(0, 6000),
  ].join("\n");

  let lastErr = "no model configured";
  for (const model of triageModels(env)) {
    try {
      const res = await openRouter(env, model, {
        max_tokens: 1500,
        messages: [
          { role: "system", content: TRIAGE_SYSTEM },
          { role: "user", content: user },
        ],
      });
      if (!res.ok) {
        const body = (await res.text()).replace(/\s+/g, " ").slice(0, 120);
        lastErr = `${model}: OpenRouter ${res.status}: ${body}`;
        continue;
      }
      const data = await res.json();
      const parsed = parseTriage(data?.choices?.[0]?.message?.content || "");
      if (parsed) return parsed;
      lastErr = `${model}: unreadable reply`;
    } catch (e) {
      lastErr = `${model}: ${e.message}`;
    }
  }
  console.error(`ai triage failed: ${lastErr}`);
  return { error: lastErr }; // fail open: alert anyway
}

async function debugAi(env) {
  if (!env.OPENROUTER_API_KEY) {
    return Response.json({ ok: false, error: "OPENROUTER_API_KEY secret is not set on the worker" }, { status: 500 });
  }
  const results = [];
  for (const model of triageModels(env)) {
    try {
      const res = await openRouter(env, model, {
        max_tokens: 300,
        messages: [{ role: "user", content: "Reply with the single word OK" }],
      });
      const text = await res.text();
      results.push({ model, ok: res.ok, status: res.status, reply: text.slice(0, 300) });
    } catch (e) {
      results.push({ model, ok: false, error: e.message });
    }
  }
  const ok = results.some((r) => r.ok);
  return Response.json({ ok, results }, { status: ok ? 200 : 502 });
}

function parseTriage(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    const score = Math.round(Number(o.score));
    if (!Number.isFinite(score)) return null;
    return {
      score: Math.max(0, Math.min(10, score)),
      effort_hours: Number.isFinite(Number(o.effort_hours)) ? Number(o.effort_hours) : "?",
      est_files: Number.isFinite(Number(o.est_files)) && o.est_files !== null ? Math.round(Number(o.est_files)) : null,
      verdict: ["solvable", "borderline", "skip"].includes(o.verdict) ? o.verdict : "borderline",
      ai_policy: ["forbids", "allows", "unknown"].includes(o.ai_policy) ? o.ai_policy : "unknown",
      reason: String(o.reason || "").slice(0, 160),
    };
  } catch (_e) {
    return null;
  }
}

// ------------------------------------------------------------ Category filter
async function repoInfo(repo, env, cache) {
  if (cache.has(repo)) return cache.get(repo);
  let info = { language: null, topics: [], archived: false };
  try {
    const res = await ghFetch(`https://api.github.com/repos/${repo}`, env);
    if (res.ok) {
      const r = await res.json();
      info = { language: r.language || null, topics: r.topics || [], archived: Boolean(r.archived) };
    }
  } catch (_e) {
    // unknown language: only docs-only issues will pass
  }
  cache.set(repo, info);
  return info;
}

function categoryGate(it, info) {
  const head = `${(it.labels || []).map((l) => l.name).join(" ")} ${it.title}`;
  const body = (it.body || "").slice(0, 3000);
  const topics = info.topics.join(" ");

  if (info.archived) return { ok: false, why: "repo archived" };
  for (const re of NEGATIVE_PATTERNS) {
    if (re.test(`${head} ${body}`)) return { ok: false, why: `out of scope (${re.source.slice(0, 30)})` };
  }
  const docsOnly = DOCS_RE.test(head);
  const langOk = Boolean(info.language) && ALLOWED_LANGS.includes(info.language);
  if (!langOk && !docsOnly) return { ok: false, why: `language ${info.language || "unknown"}` };

  const hay = `${head} ${topics} ${body.slice(0, 1500)}`;
  const matched = POSITIVE_KEYWORDS.filter((k) =>
    new RegExp(`\\b${k.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i").test(hay)
  );
  return { ok: true, language: info.language, matched: matched.slice(0, 6) };
}

// ------------------------------------------------------------ Brief
async function ghText(url, env) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github.raw+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bounty-discovery-worker",
    },
  });
  return res.ok ? res.text() : null;
}

async function buildBrief(env, it, repo, amount, ai) {
  const [contrib, comments, root] = await Promise.all([
    (async () => {
      for (const p of ["CONTRIBUTING.md", ".github/CONTRIBUTING.md", "AGENTS.md"]) {
        const t = await ghText(`https://api.github.com/repos/${repo}/contents/${p}`, env);
        if (t) return `(${p})\n${t.slice(0, 3500)}`;
      }
      return null;
    })(),
    (async () => {
      const res = await ghFetch(`${it.comments_url}?per_page=15`, env);
      if (!res.ok) return [];
      const list = await res.json();
      return list
        .filter((c) => !/bot|bountyhub|github-actions/i.test(c.user?.login || ""))
        .map((c) => `@${c.user?.login}: ${(c.body || "").slice(0, 1200)}`);
    })().catch(() => []),
    (async () => {
      const res = await ghFetch(`https://api.github.com/repos/${repo}/contents/`, env);
      if (!res.ok) return [];
      const list = await res.json();
      return Array.isArray(list) ? list.map((f) => (f.type === "dir" ? `${f.name}/` : f.name)) : [];
    })().catch(() => []),
  ]);

  const labels = (it.labels || []).map((l) => l.name).join(", ");
  return `# Bounty brief: ${it.title}

- Repo: ${repo}  (https://github.com/${repo})
- Issue: ${it.html_url}
- Amount: ${amount || "not found"}
- Labels: ${labels || "none"}
${ai ? `- AI fit: ${ai.score}/10 (~${ai.effort_hours}h) - ${ai.reason}\n- AI policy in issue text: ${ai.ai_policy}\n` : ""}
## Issue description (the maintainer's requirements)

${(it.body || "(empty)").slice(0, 8000)}

## Discussion on the issue

${comments.length ? comments.join("\n\n---\n\n") : "(no human comments yet)"}

## Contributing rules

${contrib || "(no CONTRIBUTING.md / AGENTS.md found - read the README and recent merged PRs before you start)"}

## Repo root

${root.length ? root.join("  ") : "(unavailable)"}

---

## Prompt to paste into claude.ai

I am working on a paid open-source bounty. Help me solve it properly.
Repo: ${repo}
Issue: ${it.html_url}

1. Restate the maintainer's requirements as a numbered checklist, including anything implied by the discussion.
2. Tell me exactly which files I should paste so you can work on them.
3. After I paste them, propose a minimal patch that follows the repo's conventions, plus tests, and explain every change so I can understand and adapt it.
4. Do not invent APIs or files. Ask me if something is unclear.

(Paste this whole file into claude.ai: the issue text and repo rules are above.)

---

## Before you open the PR

- [ ] Read the issue, the comments and CONTRIBUTING again; every requirement is covered
- [ ] Nobody else has an open PR for this issue (check the issue page and the PR list)
- [ ] You understand every line of the change and could explain it
- [ ] Repo's tests/lint/build pass locally; new tests added where it makes sense
- [ ] For UI changes: screenshots (before/after) attached to the PR
- [ ] PR links the issue ("Closes #${it.number}") and says that AI tools helped, if the project asks for it
- [ ] If the bounty platform needs a claim or comment first (BountyHub, Algora), do it

## PR description template

### What
<one or two sentences>

### Why
Closes #${it.number}

### How I tested
<commands and results, screenshots>

### Notes
<trade-offs, follow-ups; say that AI tools were used for assistance and that you reviewed the change>
`;
}

async function sendDocument(env, filename, content, caption) {
  const form = new FormData();
  form.append("chat_id", String(env.TELEGRAM_CHAT_ID));
  form.append("caption", caption.slice(0, 1000));
  form.append("document", new Blob([content], { type: "text/markdown" }), filename);
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`Telegram sendDocument ${res.status}`);
}

// ---------------------------------------------------------------- GitHub
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

// Amount in USD from a string like "$25", "$1,190" or "$10.00". Returns null if none.
function parseUsd(amount) {
  if (!amount) return null;
  const n = Number(String(amount).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function firstAmount(text) {
  const m = (text || "").match(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?/);
  return m ? `$${Number(m[1].replace(/,/g, "") + (m[2] || ""))}` : null;
}

// Most reliable first: labels/title, then the bounty bots' comments (BountyHub,
// Algora, ...), then the issue body (least reliable: may mention other prices).
async function findAmount(it, env) {
  const fromLabels = firstAmount(`${(it.labels || []).map((l) => l.name).join(" ")} ${it.title}`);
  if (fromLabels) return fromLabels;
  const fromBot = await botAmount(it, env);
  if (fromBot) return fromBot;
  return firstAmount((it.body || "").slice(0, 2000));
}

// BountyHub writes "A bounty of $10.00 has been created ..."; Algora "💎 $50 bounty".
async function botAmount(it, env) {
  if (!it.comments) return null; // no comments, so no bot comment either
  try {
    const res = await ghFetch(`${it.comments_url}?per_page=15`, env);
    if (!res.ok) return null;
    const comments = await res.json();
    for (const c of comments) {
      if (!/bountyhub|algora|opire|polar/i.test(c.user?.login || "")) continue;
      const m = (c.body || "").match(/bounty of\W*\$\s?([\d,]+(?:\.\d+)?)/i)
        || (c.body || "").match(/\$\s?([\d,]+(?:\.\d+)?)/);
      if (m) return `$${Number(m[1].replace(/,/g, ""))}`;
    }
  } catch (_e) {
    // amount is optional
  }
  return null;
}

// -------------------------------------------------------------- Telegram
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
