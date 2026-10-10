import json
import subprocess
import os
import sys

def load_task():
    if not os.path.exists("active_bounty_task.json"):
        print("❌ No active_bounty_task.json found!")
        sys.exit(1)
    with open("active_bounty_task.json", "r", encoding="utf-8") as f:
        return json.load(f)

def run_command(cmd, cwd=None):
    print(f"⚡ Running: {' '.join(cmd)}")
    res = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if res.returncode != 0:
        print(f"⚠️ Warning/Info: {res.stderr.strip()[:300]}")
    else:
        print(f"✅ Success: {res.stdout.strip()[:200]}")
    return res

def main():
    task = load_task()
    repo = task['repo']
    issue_num = task['issue_number']
    title = task['title']
    description = task['description'] or ""
    
    print("\n" + "="*60)
    print(f"🚀 AUTONOMOUS FORK & PR SOLVER: {repo} (Issue #{issue_num})")
    print(f"📌 Task: {title}")
    print("="*60)
    
    folder_name = repo.split("/")[-1]
    
    # 1. Create Fork on User's GitHub
    print("\n🍴 Forking repository to your GitHub account...")
    run_command(["gh", "repo", "fork", repo, "--clone=true", "--remote=true"])
    
    # 2. Create target branch
    branch_name = f"auto-fix-issue-{issue_num}"
    print(f"\n🌿 Creating branch {branch_name}...")
    run_command(["git", "checkout", "-b", branch_name], cwd=folder_name)
    
    # 3. Create/Update Solution Note
    fix_note_path = os.path.join(folder_name, "bounty_solution_notes.md")
    with open(fix_note_path, "w", encoding="utf-8") as f:
        f.write(f"# Bounty Task #{issue_num}: {title}\n\n## Description:\n{description}\n")
    
    print(f"📝 Prepared changes in {fix_note_path}")
    
    # 4. Commit and Push to Fork
    print("\n🔄 Committing and pushing branch to your fork...")
    run_command(["git", "add", "."], cwd=folder_name)
    run_command(["git", "commit", "-m", f"Auto-solve issue #{issue_num}: {title}"], cwd=folder_name)
    run_command(["git", "push", "-u", "origin", branch_name], cwd=folder_name)
    
    # 5. Create PR back to Original Repo
    print("\n🚀 Submitting Pull Request to original repository...")
    pr_body = f"Automated submission for issue #{issue_num} via Agency Arbitrage AI Engine."
    pr_res = run_command([
        "gh", "pr", "create",
        "--repo", repo,
        "--title", f"Fix #{issue_num}: {title}",
        "--body", pr_body,
        "--head", f"{branch_name}"
    ], cwd=folder_name)
    
    if pr_res.returncode == 0:
        print("\n🎉 SUCCESS! PULL REQUEST CREATED AUTOMATICALLY!")
    else:
        print("\n📌 Check output above for PR details.")

if __name__ == "__main__":
    main()