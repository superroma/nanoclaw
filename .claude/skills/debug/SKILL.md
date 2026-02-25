---
name: debug
description: Debug agent issues. Use when things aren't working, authentication problems, or to understand how the agent system works. Covers logs, environment variables, and common issues.
---

# NanoClaw Agent Debugging

This guide covers debugging the agent execution system. Agents run as native Node.js subprocesses on the host.

## Architecture Overview

```
Host (macOS)                          Agent (Node.js subprocess)
─────────────────────────────────────────────────────────────
src/container-runner.ts               container/agent-runner/
    │                                      │
    │ spawns `node` subprocess             │ runs Claude Agent SDK
    │ with env vars + stdin JSON           │ with MCP servers
    │                                      │
    │ cwd: groups/{folder}/                │ working directory
    │ HOME: data/sessions/{folder}/        │ session storage
    │ NANOCLAW_IPC_DIR: data/ipc/{folder}/ │ IPC namespace
```

Secrets (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY) are passed via stdin JSON and never written to disk or exposed as environment variables.

## Log Locations

| Log | Location | Content |
|-----|----------|---------|
| **Main app logs** | `logs/nanoclaw.log` | Host-side routing, agent spawning |
| **Main app errors** | `logs/nanoclaw.error.log` | Host-side errors |
| **Agent run logs** | `groups/{folder}/logs/agent-*.log` | Per-run: input, stderr, stdout |
| **Claude sessions** | `data/sessions/{folder}/.claude/` | Claude Code session history |

## Enabling Debug Logging

Set `LOG_LEVEL=debug` for verbose output:

```bash
# For development
LOG_LEVEL=debug npm run dev

# For launchd service (macOS), add to plist EnvironmentVariables:
<key>LOG_LEVEL</key>
<string>debug</string>
```

## Common Issues

### 1. "Agent exited with code 1"

**Check the agent log file** in `groups/{folder}/logs/agent-*.log`

Common causes:

#### Missing Authentication
```
Invalid API key · Please run /login
```
**Fix:** Ensure `.env` file exists with either OAuth token or API key:
```bash
cat .env  # Should show one of:
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...  (subscription)
# ANTHROPIC_API_KEY=sk-ant-api03-...        (pay-per-use)
```

#### Agent Runner Not Built
```
Cannot find module 'container/agent-runner/dist/index.js'
```
**Fix:** Build the agent runner:
```bash
cd container/agent-runner && npm install && npm run build
# Or build everything:
npm run build
```

### 2. Session Not Resuming

If sessions aren't being resumed (new session ID every time):

**Check HOME is set correctly:**
The agent's HOME should be `data/sessions/{group}/` so `$HOME/.claude/` resolves to the session directory.

```bash
# Verify sessions exist
ls -la data/sessions/*/. claude/projects/
```

### 3. MCP Server Failures

If an MCP server fails to start, the agent may exit. Check the agent logs for MCP initialization errors. The MCP server uses `NANOCLAW_IPC_DIR` env var to find IPC paths.

## Manual Agent Testing

### Test the full agent flow:
```bash
echo '{"prompt":"What is 2+2?","groupFolder":"test","chatJid":"test@g.us","isMain":false,"paths":{"group":"groups/test","ipc":"data/ipc/test"}}' | \
  NANOCLAW_IPC_DIR=data/ipc/test \
  HOME=data/sessions/test \
  node container/agent-runner/dist/index.js
```

## SDK Options Reference

The agent-runner uses these Claude Agent SDK options:

```typescript
query({
  prompt: input.prompt,
  options: {
    cwd: input.paths.group,  // groups/{name}/
    allowedTools: ['Bash', 'Read', 'Write', ...],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project', 'user'],
    mcpServers: { ... }
  }
})
```

## Rebuilding After Changes

```bash
# Build everything (main app + agent-runner)
npm run build

# Or build agent-runner separately
cd container/agent-runner && npm run build
```

## Session Persistence

Claude sessions are stored per-group in `data/sessions/{group}/.claude/` for isolation. Each group has its own session directory, preventing cross-group access to conversation history.

To clear sessions:

```bash
# Clear all sessions for all groups
rm -rf data/sessions/

# Clear sessions for a specific group
rm -rf data/sessions/{groupFolder}/.claude/

# Also clear the session ID from NanoClaw's tracking (stored in SQLite)
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder = '{groupFolder}'"
```

## IPC Debugging

The agent communicates back to the host via files in `data/ipc/{group}/`:

```bash
# Check pending messages
ls -la data/ipc/*/messages/

# Check pending task operations
ls -la data/ipc/*/tasks/

# Check available groups (main channel only)
cat data/ipc/main/available_groups.json

# Check current tasks snapshot
cat data/ipc/{groupFolder}/current_tasks.json
```

**IPC file types:**
- `messages/*.json` - Agent writes: outgoing messages
- `tasks/*.json` - Agent writes: task operations (schedule, pause, resume, cancel, refresh_groups)
- `current_tasks.json` - Host writes: read-only snapshot of scheduled tasks
- `available_groups.json` - Host writes: read-only list of groups (main only)

## Quick Diagnostic Script

Run this to check common issues:

```bash
echo "=== Checking NanoClaw Setup ==="

echo -e "\n1. Authentication configured?"
[ -f .env ] && (grep -q "CLAUDE_CODE_OAUTH_TOKEN=sk-" .env || grep -q "ANTHROPIC_API_KEY=sk-" .env) && echo "OK" || echo "MISSING - add CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY to .env"

echo -e "\n2. Agent runner built?"
[ -f container/agent-runner/dist/index.js ] && echo "OK" || echo "MISSING - run: npm run build"

echo -e "\n3. Groups directory?"
ls -la groups/ 2>/dev/null || echo "MISSING - run setup"

echo -e "\n4. Recent agent logs?"
ls -t groups/*/logs/agent-*.log 2>/dev/null | head -3 || echo "No agent logs yet"

echo -e "\n5. Session continuity working?"
SESSIONS=$(grep "Session initialized" logs/nanoclaw.log 2>/dev/null | tail -5 | awk '{print $NF}' | sort -u | wc -l)
[ "$SESSIONS" -le 2 ] && echo "OK (recent sessions reusing IDs)" || echo "CHECK - multiple different session IDs, may indicate resumption issues"
```
