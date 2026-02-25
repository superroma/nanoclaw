# NanoClaw Debug Checklist

## Known Issues (2026-02-08)

### 1. [FIXED] Resume branches from stale tree position
When agent teams spawns subagent CLI processes, they write to the same session JSONL. On subsequent `query()` resumes, the CLI reads the JSONL but may pick a stale branch tip (from before the subagent activity), causing the agent's response to land on a branch the host never receives a `result` for. **Fix**: pass `resumeSessionAt` with the last assistant message UUID to explicitly anchor each resume.

### 2. IDLE_TIMEOUT == CONTAINER_TIMEOUT (both 30 min)
Both timers fire at the same time, so agents always exit via hard SIGKILL instead of graceful `_close` sentinel shutdown. The idle timeout should be shorter (e.g., 5 min) so agents wind down between messages, while the hard timeout stays at 30 min as a safety net for stuck agents.

### 3. Cursor advanced before agent succeeds
`processGroupMessages` advances `lastAgentTimestamp` before the agent runs. If the agent times out, retries find no messages (cursor already past them). Messages are permanently lost on timeout.

## Quick Status Check

```bash
# 1. Is the service running?
launchctl list | grep nanoclaw
# Expected: PID  0  com.nanoclaw (PID = running, "-" = not running, non-zero exit = crashed)

# 2. Recent errors in service log?
grep -E 'ERROR|WARN' logs/nanoclaw.log | tail -20

# 3. Is WhatsApp connected? (look for last connection event)
grep -E 'Connected to WhatsApp|Connection closed|connection.*close' logs/nanoclaw.log | tail -5

# 4. Are groups loaded?
grep 'groupCount' logs/nanoclaw.log | tail -3

# 5. Any running agent processes?
ps aux | grep agent-runner | grep -v grep
```

## Session Transcript Branching

```bash
# Check for concurrent CLI processes in session debug logs
ls -la data/sessions/<group>/.claude/debug/

# Count unique SDK processes that handled messages
# Each .txt file = one CLI subprocess. Multiple = concurrent queries.

# Check parentUuid branching in transcript
python3 -c "
import json, sys
lines = open('data/sessions/<group>/.claude/projects/-workspace-group/<session>.jsonl').read().strip().split('\n')
for i, line in enumerate(lines):
  try:
    d = json.loads(line)
    if d.get('type') == 'user' and d.get('message'):
      parent = d.get('parentUuid', 'ROOT')[:8]
      content = str(d['message'].get('content', ''))[:60]
      print(f'L{i+1} parent={parent} {content}')
  except: pass
"
```

## Agent Timeout Investigation

```bash
# Check for recent timeouts
grep -E 'Agent timeout|timed out' logs/nanoclaw.log | tail -10

# Check agent log files for the timed-out agent
ls -lt groups/*/logs/agent-*.log | head -10

# Read the most recent agent log (replace path)
cat groups/<group>/logs/agent-<timestamp>.log

# Check if retries were scheduled and what happened
grep -E 'Scheduling retry|retry|Max retries' logs/nanoclaw.log | tail -10
```

## Agent Not Responding

```bash
# Check if messages are being received
grep 'New messages' logs/nanoclaw.log | tail -10

# Check if messages are being processed (agent spawned)
grep -E 'Processing messages|Spawning native agent' logs/nanoclaw.log | tail -10

# Check if messages are being piped to active agent
grep -E 'Piped messages|sendMessage' logs/nanoclaw.log | tail -10

# Check the queue state — any active agents?
grep -E 'Starting.*for group|Container active|concurrency limit' logs/nanoclaw.log | tail -10

# Check lastAgentTimestamp vs latest message timestamp
sqlite3 store/messages.db "SELECT chat_jid, MAX(timestamp) as latest FROM messages GROUP BY chat_jid ORDER BY latest DESC LIMIT 5;"
```

## WhatsApp Auth Issues

```bash
# Check if QR code was requested (means auth expired)
grep 'QR\|authentication required\|qr' logs/nanoclaw.log | tail -5

# Check auth files exist
ls -la store/auth/

# Re-authenticate if needed
npm run auth
```

## Service Management

```bash
# Restart the service
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# View live logs
tail -f logs/nanoclaw.log

# Stop the service
launchctl bootout gui/$(id -u)/com.nanoclaw

# Start the service
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nanoclaw.plist

# Rebuild after code changes
npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```
