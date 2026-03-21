# Per-Group Runtime Mode: Native vs Container

## Summary

Add per-group runtime selection so groups can run agents either natively (current behavior) or inside Apple Containers. The `main` group continues running natively with full host access. The new `zbadmin` group runs in an Apple Container with `~/work/zb-mdz` mounted read-write for git operations.

## Motivation

The main agent needs native macOS access (dev tools, filesystem, etc.). Other agents like zbadmin need container isolation — they operate on specific repos and should be sandboxed. Supporting both modes per-group gives flexibility without sacrificing either use case.

## Design

### Runtime field

Add `runtime` to `ContainerConfig` in `src/types.ts`:

```typescript
export interface ContainerConfig {
  runtime?: 'native' | 'container'; // Default: 'native'
  additionalMounts?: AdditionalMount[];
  timeout?: number;
}
```

### container-runtime.ts

Restore from `.nanoclaw/base/src/container-runtime.ts` but adapted for Apple Container CLI:

- `CONTAINER_RUNTIME_BIN` = `'container'` (Apple CLI)
- `readonlyMountArgs(host, container)` returns `['--mount', 'type=bind,source=${host},target=${container},readonly']`
- `writableMountArgs(host, container)` returns `['-v', '${host}:${container}']`
- `stopContainer(name)` returns `container stop ${name}`
- `ensureContainerRuntimeRunning()` checks `container system info`
- `cleanupOrphans()` lists and stops `nanoclaw-*` containers

### container-runner.ts

Branch on `group.containerConfig?.runtime`:

**`"native"` or undefined (default):** Current native spawn logic — `spawn('node', [agentRunnerScript], ...)`. No changes.

**`"container"`:** Restore container spawn logic from `.nanoclaw/base/src/container-runner.ts`:
1. `buildVolumeMounts()` — assemble volume mounts (group dir, IPC, sessions, global, additional mounts validated via `mount-security.ts`)
2. `buildContainerArgs()` — construct `container run -i --rm --name ... -v ... IMAGE` args
3. Spawn via `spawn('container', containerArgs, ...)`
4. Same stdin/stdout/stderr handling, timeout logic, and output parsing as native mode

The two spawn paths share: secret handling, output parsing, timeout logic, log writing. Only the process spawning and mount setup differ.

### Git PAT handling

- Add `ZB_GIT_PAT` to `.env`
- Add to allowed secrets in `readSecrets()` (both values: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ZB_GIT_PAT`)
- Agent-runner: if `ZB_GIT_PAT` secret is present, configure git credential helper on startup:
  ```bash
  git config --global credential.helper '!f() { echo "password=$ZB_GIT_PAT"; }; f'
  ```
  This runs inside the container before the agent starts.

### Mount allowlist

Create `~/.config/nanoclaw/mount-allowlist.json`:

```json
{
  "allowedRoots": [
    {
      "path": "~/work",
      "allowReadWrite": true,
      "description": "Work repositories"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": false
}
```

The existing `mount-security.ts` validates mounts against this allowlist. No changes needed to that module.

### zbadmin group registration

SQLite insert into `registered_groups`:

| Field | Value |
|-------|-------|
| jid | `tg:-5176807980` |
| name | `zbadmin` |
| folder | `zbadmin` |
| trigger_pattern | (empty) |
| requires_trigger | false |
| container_config | `{"runtime": "container", "additionalMounts": [{"hostPath": "~/work/zb-mdz", "readonly": false}]}` |

### groups/zbadmin/CLAUDE.md

System prompt for the agent:
- Primary workspace: `/workspace/extra/zb-mdz` (the mounted repo)
- Can read, write, commit, and push via git
- Git authentication is pre-configured via credential helper

### Container image

Build using existing `container/Dockerfile`:
```bash
container build -t nanoclaw-agent:latest container/
```

The Dockerfile already installs git, node, chromium, and the agent-runner.

## Files changed

| File | Change |
|------|--------|
| `src/types.ts` | Add `runtime` field to `ContainerConfig` |
| `src/container-runtime.ts` | Restore with Apple Container CLI support |
| `src/container-runner.ts` | Add container spawn path alongside native |
| `src/config.ts` | Add `CONTAINER_IMAGE` constant if missing |
| `container/agent-runner/src/index.ts` | Add git PAT credential helper setup |
| `groups/zbadmin/CLAUDE.md` | New file — agent system prompt |
| `~/.config/nanoclaw/mount-allowlist.json` | New file — mount security config |
| `.env` | Add `ZB_GIT_PAT` |

## Out of scope

- Docker support (only Apple Container)
- UI for switching runtimes (direct DB/config only)
- Per-group container image selection (all use `nanoclaw-agent:latest`)
