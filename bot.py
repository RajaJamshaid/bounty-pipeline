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

def load_task():
    if not os.path.exists("active_bounty_task.json"):
        print("ℹ️ No active task found.")
        sys.exit(0)
    with open("active_bounty_task.json", "r") as f:
        return json.load(f)

def run_tests():
    """ Runs project tests to verify if build is GREEN """
    print("🧪 Running local test suite...")
    # Add project specific test commands (e.g. npm test or pytest)
    if os.path.exists("package.json"):
        res = subprocess.run(["npm", "test"], capture_output=True, text=True)
    elif os.path.exists("pytest.ini") or os.path.exists("requirements.txt"):
        res = subprocess.run(["pytest"], capture_output=True, text=True)
    else:
        return True, "No standard test framework detected (Skipped tests)."

    if res.returncode == 0:
        return True, res.stdout[:500]
    else:
        return False, res.stderr[:500]

def main():
    task = load_task()
    repo = task.get('repo')
    issue_num = task.get('issue_number')
    title = task.get('title')
    amount = task.get('amount_usd', 0)
    url = task.get('url', '')

    print(f"\n🚀 PROCESSING BOUNTY: {title} (${amount})")
    
    # 1. Test Verification
    test_passed, test_log = run_tests()
    
    status_icon = "🟢 GREEN" if test_passed else "🔴 RED"
    
    # 2. Build Summary Message for Telegram Review
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

    # 3. Send Notification to Telegram
    send_telegram_msg(msg)

if __name__ == "__main__":
    main()
