#!/usr/bin/env python3
"""
Human-in-the-Loop bounty bot.

Flow: read active_bounty_task.json -> clone target repo (token auth, never
prompts) -> run tests (npm test / pytest) -> send review report to Telegram.

Env vars:
  GH_PAT or GITHUB_TOKEN   token used for git clone (GH_PAT wins)
  TELEGRAM_BOT_TOKEN       Telegram bot token
  TELEGRAM_CHAT_ID         Telegram chat to notify
Optional:
  TASK_FILE (default active_bounty_task.json)
  WORK_DIR  (default current dir, so the clone lands at ./<repo-name> where solver.py expects it)
"""

import base64
import json
import os
import re
import shutil
import subprocess
import sys
import traceback
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

TASK_FILE = os.environ.get("TASK_FILE", "active_bounty_task.json")
WORK_DIR = Path(os.environ.get("WORK_DIR", ".")).resolve()
GH_TOKEN = (os.environ.get("GH_PAT") or os.environ.get("GITHUB_TOKEN") or "").strip()
TG_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
TG_CHAT = os.environ.get("TELEGRAM_CHAT_ID", "").strip()

CLONE_TIMEOUT = 300
INSTALL_TIMEOUT = 600
TEST_TIMEOUT = 900
TG_LIMIT = 4000  # Telegram hard limit is 4096 chars

LOGS = []  # human-readable task log


# ----------------------------------------------------------------- helpers
def log(msg):
    line = f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] {msg}"
    print(mask(line), flush=True)
    LOGS.append(mask(line))


def mask(text):
    """Never leak tokens into logs or Telegram."""
    text = text or ""
    for secret in (GH_TOKEN, TG_TOKEN):
        if secret:
            text = text.replace(secret, "***")
    if GH_TOKEN:
        text = text.replace(base64.b64encode(f"x-access-token:{GH_TOKEN}".encode()).decode(), "***")
    return text


def tail(text, n=1500):
    text = mask(text or "").strip()
    return text if len(text) <= n else "..." + text[-n:]


def run(cmd, cwd=None, timeout=300, env_extra=None):
    """Run a command, never raise. Returns (returncode, combined_output)."""
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"  # never prompt for credentials
    env["GCM_INTERACTIVE"] = "never"
    env["CI"] = "true"
    if env_extra:
        env.update(env_extra)
    try:
        p = subprocess.run(
            cmd, cwd=cwd, env=env, timeout=timeout,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, errors="replace",
        )
        return p.returncode, p.stdout or ""
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        return 124, f"{out}\nTIMEOUT after {timeout}s"
    except FileNotFoundError:
        return 127, f"Command not found: {cmd[0]}"
    except Exception as e:  # noqa: BLE001
        return 1, f"{type(e).__name__}: {e}"


# ---------------------------------------------------------------- telegram
def tg_send(text):
    if not (TG_TOKEN and TG_CHAT):
        print("Telegram not configured; report printed below:\n" + text)
        return False
    ok = True
    chunks = [text[i:i + TG_LIMIT] for i in range(0, len(text), TG_LIMIT)] or [""]
    for chunk in chunks:
        try:
            data = urllib.parse.urlencode({
                "chat_id": TG_CHAT,
                "text": chunk,
                "disable_web_page_preview": "true",
            }).encode()
            req = urllib.request.Request(
                f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage", data=data)
            with urllib.request.urlopen(req, timeout=30) as r:
                ok = ok and r.status == 200
        except Exception as e:  # noqa: BLE001
            print(f"Telegram send failed: {mask(str(e))}")
            ok = False
    return ok


# -------------------------------------------------------------------- task
def load_task():
    p = Path(TASK_FILE)
    if not p.is_file():
        raise FileNotFoundError(f"{TASK_FILE} not found")
    data = json.loads(p.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{TASK_FILE} must contain a JSON object")
    return data


def pick(task, *keys, default=""):
    for k in keys:
        v = task.get(k)
        if v not in (None, ""):
            return v
    return default


def parse_repo(raw):
    """Accept 'owner/repo', https URLs, .git suffix, /issues/123 paths, git@ URLs."""
    raw = (raw or "").strip()
    if not raw:
        return None
    m = re.match(r"^git@github\.com:([\w.-]+)/([\w.-]+?)(?:\.git)?/?$", raw)
    if not m:
        m = re.match(r"^(?:https?://)?(?:www\.)?github\.com/([\w.-]+)/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$", raw)
    if not m:
        m = re.match(r"^([\w.-]+)/([\w.-]+?)(?:\.git)?$", raw)
    if not m:
        return None
    return m.group(1), m.group(2)


# -------------------------------------------------------------------- clone
def clone_repo(owner, repo):
    """Returns (path|None, error|None). Token goes in a header, not the URL,
    so it is never written to .git/config or shown in process listings."""
    dest = WORK_DIR / repo
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    WORK_DIR.mkdir(parents=True, exist_ok=True)

    url = f"https://github.com/{owner}/{repo}.git"
    cmd = ["git"]
    if GH_TOKEN:
        basic = base64.b64encode(f"x-access-token:{GH_TOKEN}".encode()).decode()
        cmd += ["-c", f"http.https://github.com/.extraheader=AUTHORIZATION: basic {basic}"]
    cmd += ["clone", "--depth", "1", url, str(dest)]

    log(f"Cloning {owner}/{repo} (auth: {'token' if GH_TOKEN else 'none'})")
    code, out = run(cmd, timeout=CLONE_TIMEOUT)
    if code == 0 and dest.is_dir():
        log("Clone OK")
        return dest, None

    low = out.lower()
    if "could not read username" in low or "authentication failed" in low or "403" in low:
        reason = "Auth failed - repo is private or token lacks access (check GH_PAT scopes: repo)."
    elif "not found" in low or ("repository" in low and "not exist" in low):
        reason = "Repository not found (invalid URL, or private and token has no access)."
    elif code == 124:
        reason = "Clone timed out."
    else:
        reason = "git clone failed."
    return None, f"{reason}\n{tail(out, 600)}"


# -------------------------------------------------------------------- tests
def detect_and_test(repo_dir):
    """Returns (status, summary, output). status: GREEN | RED."""
    pkg = repo_dir / "package.json"
    py_markers = ["pytest.ini", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "tox.ini"]
    has_py = any((repo_dir / m).exists() for m in py_markers) or any(repo_dir.glob("test*/**/test_*.py")) \
        or any(repo_dir.glob("test_*.py"))

    results = []  # (name, ok, output)

    if pkg.is_file():
        results.append(run_node(repo_dir))
    if has_py:
        results.append(run_python(repo_dir))

    if not results:
        return "RED", "No supported test suite found (no package.json / Python project).", ""

    ok = all(r[1] for r in results)
    summary = " | ".join(f"{name}: {'PASS' if good else 'FAIL'}" for name, good, _ in results)
    output = "\n\n".join(f"--- {name} ---\n{tail(out, 1500)}" for name, _, out in results)
    return ("GREEN" if ok else "RED"), summary, output


def run_node(repo_dir):
    try:
        pkg = json.loads((repo_dir / "package.json").read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        pkg = {}
    if "test" not in (pkg.get("scripts") or {}):
        log("Node: no 'test' script in package.json")
        return "npm test", False, "package.json has no 'test' script."

    installer = ["npm", "ci"] if (repo_dir / "package-lock.json").exists() else ["npm", "install"]
    log(f"Node: {' '.join(installer)}")
    code, out = run(installer + ["--no-audit", "--no-fund"], cwd=repo_dir, timeout=INSTALL_TIMEOUT)
    if code != 0:
        return "npm test", False, f"Install failed:\n{tail(out, 1200)}"
    log("Node: npm test")
    code, out = run(["npm", "test"], cwd=repo_dir, timeout=TEST_TIMEOUT)
    return "npm test", code == 0, out


def run_python(repo_dir):
    for req in ("requirements.txt", "requirements-dev.txt", "dev-requirements.txt"):
        if (repo_dir / req).is_file():
            log(f"Python: pip install -r {req}")
            run([sys.executable, "-m", "pip", "install", "-q", "-r", req], cwd=repo_dir, timeout=INSTALL_TIMEOUT)
    if any((repo_dir / f).exists() for f in ("pyproject.toml", "setup.py")):
        log("Python: pip install -e .")
        run([sys.executable, "-m", "pip", "install", "-q", "-e", "."], cwd=repo_dir, timeout=INSTALL_TIMEOUT)

    log("Python: pytest")
    code, out = run([sys.executable, "-m", "pytest", "-q", "--maxfail=20"], cwd=repo_dir, timeout=TEST_TIMEOUT)
    if code == 5:  # pytest: no tests collected
        return "pytest", False, "pytest collected no tests.\n" + out
    return "pytest", code == 0, out


# ------------------------------------------------------------------- report
def build_report(task, status, summary, output, error=None):
    icon = "🟢 GREEN" if status == "GREEN" else "🔴 RED"
    title = pick(task, "title", "name", "issue_title", default="(untitled)")
    amount = pick(task, "amount_usd", "bounty", "amount", "reward", "prize", default=None)
    bounty = f"${amount}" if isinstance(amount, (int, float)) else (amount or "n/a")
    issue = pick(task, "url", "issue_url", "link", default="n/a")
    repo = pick(task, "repo", "repo_url", "repository", default="n/a")
    issue_no = pick(task, "issue_number", "id", "task_id", default="n/a")

    lines = [
        "🎯 NEW BOUNTY READY FOR HUMAN REVIEW",
        f"Test Status: {icon}",
        "",
        f"📌 Task: {title}",
        f"🔢 Issue: #{issue_no}",
        f"💰 Bounty: {bounty}",
        f"📦 Repo: {repo}",
        f"🔗 Link: {issue}",
        "",
        f"🧪 Summary: {summary}",
    ]
    if error:
        lines += ["", f"⚠️ Error: {error}"]
    if output:
        lines += ["", "📄 Test output:", tail(output, 1800)]
    lines += ["", "📝 Task log:", tail("\n".join(LOGS), 900)]
    run_url = os.environ.get("GITHUB_SERVER_URL"), os.environ.get("GITHUB_REPOSITORY"), os.environ.get("GITHUB_RUN_ID")
    if all(run_url):
        lines += ["", f"▶️ Run: {run_url[0]}/{run_url[1]}/actions/runs/{run_url[2]}"]
    lines += ["", "👉 Action needed: review the code, then submit the PR yourself."]
    return "\n".join(lines)


# --------------------------------------------------------------------- main
def main():
    task, status, summary, output, error = {}, "RED", "", "", None
    try:
        log(f"Loading {TASK_FILE}")
        task = load_task()

        raw_repo = pick(task, "repo", "repo_url", "repository", "clone_url", "issue_url", "url")
        parsed = parse_repo(str(raw_repo))
        if not parsed:
            error = f"Invalid or missing repository URL: {raw_repo!r}"
            summary = "Could not determine repository."
        else:
            repo_dir, clone_err = clone_repo(*parsed)
            if clone_err or repo_dir is None:
                error = clone_err
                summary = "Clone failed - tests not run."
            else:
                try:
                    status, summary, output = detect_and_test(repo_dir)
                except Exception as e:  # noqa: BLE001
                    error = f"Test runner crashed: {type(e).__name__}: {e}"
                    summary = "Test execution error."
                    log(error)
    except Exception as e:  # noqa: BLE001
        error = f"{type(e).__name__}: {e}"
        summary = "Bot hit an unexpected error."
        log(mask(traceback.format_exc()))

    if error:
        log(f"ERROR: {error.splitlines()[0]}")
    try:
        tg_send(build_report(task, status, summary, output, mask(error) if error else None))
    except Exception as e:  # noqa: BLE001
        print(f"Report failed: {mask(str(e))}")

    # Always exit 0 so the workflow stays alive for the human-review step.
    # Change to `sys.exit(0 if status == "GREEN" else 1)` to fail the job on RED.
    sys.exit(0)


if __name__ == "__main__":
    main()
