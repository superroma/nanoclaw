# NanoClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Agent processes | Native | Full host access as subprocesses |
| WhatsApp messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Agent Isolation (Per-Group)

Agents execute as native Node.js subprocesses on the host:
- **Per-group working directory** - Each agent's cwd is set to `groups/{name}/`
- **Per-group HOME** - Set to `data/sessions/{group}/` for isolated `.claude/` sessions
- **Per-group IPC namespace** - Each group has its own IPC directory
- **Full host access** - Agents can access host dev tools and filesystem

Note: Unlike container-based isolation, native agents have full host access. Security relies on per-group session isolation and IPC authorization rather than OS-level sandboxing.

### 2. Session Isolation

Each group has isolated Claude sessions at `data/sessions/{group}/.claude/`:
- Groups cannot see other groups' conversation history
- Session data includes full message history and file contents read
- Prevents cross-group information disclosure

### 3. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | Yes | Yes |
| Send message to other chats | Yes | No |
| Schedule task for self | Yes | Yes |
| Schedule task for others | Yes | No |
| View all tasks | Yes | Own only |
| Manage other groups | Yes | No |

### 4. Credential Handling

**Passed via stdin (never on disk):**
- Claude auth tokens (filtered from `.env`)

**NOT Exposed:**
- WhatsApp session (`store/auth/`) - host only
- Secrets stripped from Bash subprocess environments via PreToolUse hook

**Credential Filtering:**
Only these secrets are passed to agents:
```typescript
const allowedVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
```

> **Note:** Anthropic credentials are passed so that Claude Code can authenticate when the agent runs. A PreToolUse hook strips secret env vars from Bash commands to prevent discovery.

## Privilege Comparison

| Capability | Main Group | Non-Main Group |
|------------|------------|----------------|
| Project root access | Full (read-only recommended) | Working dir only |
| Group folder | `groups/main/` (rw) | `groups/{name}/` (rw) |
| Global memory | Read/Write | Read-only |
| Host tools | Full access | Full access |
| Network access | Unrestricted | Unrestricted |
| MCP tools | All | All |

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  WhatsApp/Telegram Messages (potentially malicious)               │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input formatting
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                                │
│  • IPC authorization                                              │
│  • Agent lifecycle                                                │
│  • Credential filtering                                           │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Spawns subprocess with isolated HOME/cwd
┌──────────────────────────────────────────────────────────────────┐
│                  AGENT (NATIVE SUBPROCESS)                        │
│  • Agent execution (Claude Agent SDK)                             │
│  • Bash commands (full host access)                               │
│  • File operations (full filesystem)                              │
│  • Network access (unrestricted)                                  │
│  • Cannot modify security config (IPC auth on host)               │
└──────────────────────────────────────────────────────────────────┘
```
