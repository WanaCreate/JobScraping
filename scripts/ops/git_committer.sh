#!/bin/bash
# Lightweight git-only committer. Commits/pushes output every 8 min.
# git works regardless of HTTPS proxy port (local git server), so this is
# robust to proxy rotation. Does NOT manage the pipeline — that's done via
# scheduled wakeups which get a fresh proxy. Runs until removed/killed.
cd /home/user/JobScraping || exit 0
BRANCH="claude/jobsdrop-2-1-phase-1-vb58zk"
ML="/tmp/claude-0/-home-user-JobScraping/46c584e1-9745-5238-8516-0e8979f24c5c/scratchpad/monitor.log"
while true; do
  sleep 480
  git add -f outputs/ pipeline/new_companies_discovered.json 2>/dev/null || true
  if ! git diff --cached --quiet 2>/dev/null; then
    git commit -q -m "chore: pipeline progress checkpoint [auto]

Co-Authored-By: Claude <noreply@anthropic.com>" 2>/dev/null || true
    for i in 1 2 3 4; do
      git push origin "$BRANCH" 2>/dev/null && break
      sleep $((2**i))
    done
    echo "[committer $(date -u +%H:%M:%S)] pushed checkpoint" >> "$ML"
  fi
done
