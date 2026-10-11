import os
import sys
import json
import subprocess
import requests

# --- Git Identity Configuration ---
os.system('git config --global user.name "RajaJamshaid"')
os.system('git config --global user.email "rajajamshaid22@gmail.com"')

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

def send_telegram_msg(text):
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("⚠️ Telegram credentials not found in environment!")
        return
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text,
        "parse_mode": "Markdown"
    }
    try:
        res = requests.post(url, json=payload)
        if res.status_code == 200:
            print("✅ Telegram notification sent successfully!")
        else:
            print(f"❌ Telegram API Error: {res.text}")
    except Exception as e:
        print(f"❌ Failed to send Telegram notification: {e}")

def main():
    # Root workspace path save kar lein
    root_dir = os.path.abspath(os.getcwd())
    task_path = os.path.join(root_dir, "active_bounty_task.json")
    
    if not os.path.exists(task_path):
        # Try finding in parent directory if triggered differently
        parent_task = os.path.join(os.path.dirname(root_dir), "active_bounty_task.json")
        if os.path.exists(parent_task):
            task_path = parent_task
        else:
            print("ℹ️ No active task found.")
            sys.exit(0)

    with open(task_path, "r") as f:
        task = json.load(f)

    repo = task.get('repo') # e.g. "appsweb/featweb"
    issue_num = task.get('issue_number')
    title = task.get('title')
    amount = task.get('amount_usd', 0)
    url = task.get('url', '')

    print(f"\n🚀 PROCESSING BOUNTY: {title} (${amount})")

    repo_name = repo.split('/')[-1] # "featweb"
    target_repo_path = os.path.join(root_dir, repo_name)

    # 1. Clone or Update Target Repository safely
    if not os.path.exists(target_repo_path):
        print(f"📥 Cloning repository: https://github.com/{repo}.git into {target_repo_path}")
        clone_res = subprocess.run(["git", "clone", f"https://github.com/{repo}.git", target_repo_path], capture_output=True, text=True)
        if clone_res.returncode != 0:
            print(f"❌ Git clone failed: {clone_res.stderr}")
    
    # 2. Change working directory safely to target repo
    if os.path.exists(target_repo_path):
        os.chdir(target_repo_path)
    else:
        print(f"❌ Target directory {target_repo_path} does not exist!")
        sys.exit(1)

    # 3. Run Tests
    print("🧪 Running local test suite...")
    test_log = "No standard test framework detected (Skipped tests)."
    test_passed = True

    if os.path.exists("package.json"):
        res = subprocess.run(["npm", "test"], capture_output=True, text=True)
        test_passed = (res.returncode == 0)
        test_log = res.stdout[:500] if test_passed else res.stderr[:500]
    elif os.path.exists("pytest.ini") or os.path.exists("requirements.txt") or os.path.exists("setup.py"):
        res = subprocess.run(["pytest"], capture_output=True, text=True)
        test_passed = (res.returncode == 0)
        test_log = res.stdout[:500] if test_passed else res.stderr[:500]

    status_icon = "🟢 GREEN" if test_passed else "🔴 RED"

    # 4. Build Telegram Notification
    msg = (
        f"🎯 *NEW BOUNTY READY FOR HUMAN REVIEW*\n\n"
        f"📌 *Repo:* `{repo}`\n"
        f"🔢 *Issue:* #{issue_num}\n"
        f"💰 *Reward:* ${amount}\n"
        f"📝 *Title:* {title}\n"
        f"🧪 *Tests Status:* {status_icon}\n\n"
        f"🔗 *Bounty Link:* [View Issue]({url})\n\n"
        f"📋 *Test Logs / Details:*\n```\n{test_log[:300]}\n```\n\n"
        f"👉 *Action Needed:* Code review karein aur GitHub par PR submit karein!"
    )

    # 5. Send Notification
    send_telegram_msg(msg)
    print("✨ Pipeline execution finished successfully.")

if __name__ == "__main__":
    main()
