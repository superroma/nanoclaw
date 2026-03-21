# iiko MCP Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add iiko restaurant API tools to the existing nanoclaw MCP server so all agents can query sales reports, products, employees, stores, and other data.

**Architecture:** Extend the existing `ipc-mcp-stdio.ts` MCP server with an `IikoClient` class (separate file) that handles auth token lifecycle and HTTP requests. Credentials flow from `.env` → `readSecrets()` → agent-runner stdin → MCP server env vars.

**Tech Stack:** TypeScript, Node.js built-in `fetch()`, `@modelcontextprotocol/sdk`, `zod`

**Spec:** `docs/superpowers/specs/2026-03-22-iiko-mcp-tools-design.md`

---

### Task 1: Add iiko credentials to .env and secrets pipeline

**Files:**
- Modify: `.env` — add 3 iiko env vars
- Modify: `src/container-runner.ts:107` — add iiko keys to `readSecrets()` allowlist

- [ ] **Step 1: Add iiko env vars to `.env`**

Append to `.env`:

```
IIKO_HOST=bar-zebitlz.iiko.it
IIKO_LOGIN=otchet
IIKO_PASS_HASH=73603ec2e1828e6b384c2c5ecfb95146db74b786
```

- [ ] **Step 2: Add iiko keys to `readSecrets()` in `src/container-runner.ts`**

Change line 107 from:

```typescript
return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ZB_GIT_PAT']);
```

to:

```typescript
return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ZB_GIT_PAT', 'IIKO_HOST', 'IIKO_LOGIN', 'IIKO_PASS_HASH']);
```

- [ ] **Step 3: Commit**

```bash
git add .env src/container-runner.ts
git commit -m "feat: add iiko credentials to secrets pipeline"
```

---

### Task 2: Pass iiko env vars to MCP server and add permissions

**Files:**
- Modify: `container/agent-runner/src/index.ts:445,455-459` — add iiko env vars to MCP server env block, add iiko tool permission

- [ ] **Step 1: Add `mcp__nanoclaw__iiko_*` to allowed tools**

In `container/agent-runner/src/index.ts`, find the `allowedTools` array (around line 445). After `'mcp__nanoclaw__*'`, the wildcard already covers iiko tools — no change needed here. Verify this by confirming the existing `'mcp__nanoclaw__*'` pattern matches `mcp__nanoclaw__iiko_olap_report` etc.

> Note: `mcp__nanoclaw__*` already covers all tools on the nanoclaw MCP server, including new iiko ones. No permission changes needed.

- [ ] **Step 2: Add iiko env vars to MCP server's `env` block**

In `container/agent-runner/src/index.ts`, find the `mcpServers` config (around line 451-460). Change the `env` block from:

```typescript
env: {
  NANOCLAW_CHAT_JID: containerInput.chatJid,
  NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
  NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
},
```

to:

```typescript
env: {
  NANOCLAW_CHAT_JID: containerInput.chatJid,
  NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
  NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
  IIKO_HOST: sdkEnv.IIKO_HOST || '',
  IIKO_LOGIN: sdkEnv.IIKO_LOGIN || '',
  IIKO_PASS_HASH: sdkEnv.IIKO_PASS_HASH || '',
},
```

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat: pass iiko env vars to MCP server process"
```

---

### Task 3: Create IikoClient class

**Files:**
- Create: `container/agent-runner/src/iiko-client.ts`

- [ ] **Step 1: Create `container/agent-runner/src/iiko-client.ts`**

```typescript
/**
 * iiko Server API client with automatic auth token management.
 * Uses the on-premise iikoServer REST API at /resto/api/.
 * Each active token consumes one license slot — logout releases it.
 */

const REQUEST_TIMEOUT = 30_000;

export class IikoClient {
  private token: string | null = null;
  private readonly host: string;
  private readonly login: string;
  private readonly passHash: string;

  constructor(host: string, login: string, passHash: string) {
    this.host = host;
    this.login = login;
    this.passHash = passHash;
  }

  private get baseUrl(): string {
    return `https://${this.host}/resto/api`;
  }

  async getToken(): Promise<string> {
    if (this.token) return this.token;

    const url = `${this.baseUrl}/auth?login=${encodeURIComponent(this.login)}&pass=${encodeURIComponent(this.passHash)}`;
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`iiko auth failed (${res.status}): ${body}`);
    }

    this.token = (await res.text()).trim();
    return this.token;
  }

  async request(method: string, path: string, body?: object): Promise<unknown> {
    const doRequest = async (): Promise<Response> => {
      const token = await this.getToken();
      const separator = path.includes('?') ? '&' : '?';
      const url = `${this.baseUrl}${path}${separator}key=${token}`;

      const options: RequestInit = {
        method,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      };

      if (body) {
        options.headers = { 'Content-Type': 'application/json; charset=utf-8' };
        options.body = JSON.stringify(body);
      }

      return fetch(url, options);
    };

    let res = await doRequest();

    // Retry once on 401 (expired token)
    if (res.status === 401) {
      this.token = null;
      res = await doRequest();
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`iiko API error (${res.status}) ${method} ${path}: ${text}`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return res.json();
    }
    return res.text();
  }

  async logout(): Promise<void> {
    if (!this.token) return;
    try {
      await fetch(`${this.baseUrl}/logout?key=${this.token}`, {
        method: 'GET',
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // Best-effort logout — don't throw on failure
    }
    this.token = null;
  }
}

/**
 * Create an IikoClient from environment variables, or return null if not configured.
 * Also registers SIGTERM handler for clean logout.
 */
export function createIikoClient(): IikoClient | null {
  const host = process.env.IIKO_HOST;
  const login = process.env.IIKO_LOGIN;
  const passHash = process.env.IIKO_PASS_HASH;

  if (!host || !login || !passHash) return null;

  const client = new IikoClient(host, login, passHash);

  process.on('SIGTERM', () => {
    client.logout().finally(() => process.exit(0));
  });

  return client;
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd container/agent-runner && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/iiko-client.ts
git commit -m "feat: add IikoClient with auth token management"
```

---

### Task 4: Register iiko tools in MCP server

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts` — import IikoClient, add 7 tool registrations

- [ ] **Step 1: Add iiko import and client initialization**

At the top of `ipc-mcp-stdio.ts`, after the existing imports (line 12), add:

```typescript
import { createIikoClient } from './iiko-client.js';

const iikoClient = createIikoClient();
```

- [ ] **Step 2: Add helper for iiko tool error handling**

After the `iikoClient` initialization, add:

```typescript
function iikoNotConfigured() {
  return {
    content: [{ type: 'text' as const, text: 'iiko integration not configured. Set IIKO_HOST, IIKO_LOGIN, IIKO_PASS_HASH in .env.' }],
    isError: true,
  };
}

function iikoError(err: unknown) {
  return {
    content: [{ type: 'text' as const, text: `iiko error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}
```

- [ ] **Step 3: Add `iiko_olap_columns` tool**

After the `register_group` tool (before `// Start the stdio transport`), add:

```typescript
server.tool(
  'iiko_olap_columns',
  'Get available OLAP report fields with their types and capabilities (grouping, aggregation, filtering). Call this to discover which fields you can use in iiko_olap_report.',
  {
    report_type: z.enum(['SALES', 'TRANSACTIONS', 'DELIVERIES']).describe('Report type'),
  },
  async (args) => {
    if (!iikoClient) return iikoNotConfigured();
    try {
      const data = await iikoClient.request('GET', `/v2/reports/olap/columns?reportType=${args.report_type}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return iikoError(err);
    }
  },
);
```

- [ ] **Step 4: Add `iiko_olap_report` tool**

```typescript
server.tool(
  'iiko_olap_report',
  `Query iiko OLAP reports for sales, transaction, or delivery analytics. Builds the request with standard exclusion filters (non-deleted orders only, no stornos).

Use iiko_olap_columns first to discover available fields for grouping and aggregation.

Common group_by_rows fields (SALES): DishName, DishGroup, DishCategory, Department, Cashier, OpenDate.Typed, YearOpen, MonthOpen, WeekInYearOpen, DayOfWeekOpen, HourOpen, OrderNum, WaiterName, TableNum
Common aggregate_fields (SALES): DishSumInt, DishDiscountSumInt, DishAmountInt, UniqOrderId, ProductCostBase.OneItem, FullSum`,
  {
    report_type: z.enum(['SALES', 'TRANSACTIONS', 'DELIVERIES']).describe('Report type'),
    date_from: z.string().describe('Start date YYYY-MM-DD'),
    date_to: z.string().describe('End date YYYY-MM-DD'),
    group_by_rows: z.array(z.string()).describe('Fields to group by rows'),
    aggregate_fields: z.array(z.string()).describe('Fields to aggregate'),
    filters: z.record(z.any()).optional().describe('Additional filters (iiko filter format). Date and deletion filters are added automatically.'),
  },
  async (args) => {
    if (!iikoClient) return iikoNotConfigured();
    try {
      const body = {
        reportType: args.report_type,
        buildSummary: 'false',
        groupByRowFields: args.group_by_rows,
        aggregateFields: args.aggregate_fields,
        filters: {
          'OpenDate.Typed': {
            filterType: 'DateRange',
            periodType: 'CUSTOM',
            from: `${args.date_from}T00:00:00.000`,
            to: `${args.date_to}T00:00:00.000`,
            includeLow: 'true',
            includeHigh: 'true',
          },
          OrderDeleted: {
            filterType: 'IncludeValues',
            values: ['NOT_DELETED'],
          },
          DeletedWithWriteoff: {
            filterType: 'ExcludeValues',
            values: ['DELETED_WITH_WRITEOFF', 'DELETED_WITHOUT_WRITEOFF'],
          },
          Storned: {
            filterType: 'ExcludeValues',
            values: ['TRUE'],
          },
          ...(args.filters || {}),
        },
      };

      const result = await iikoClient.request('POST', '/v2/reports/olap', body) as { data?: unknown[] };
      const data = result.data || result;
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return iikoError(err);
    }
  },
);
```

- [ ] **Step 5: Add reference data tools (stores, departments, products, suppliers, employees)**

```typescript
server.tool(
  'iiko_stores',
  'List all stores/warehouses from iiko.',
  {},
  async () => {
    if (!iikoClient) return iikoNotConfigured();
    try {
      const data = await iikoClient.request('GET', '/corporation/stores');
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return iikoError(err);
    }
  },
);

server.tool(
  'iiko_departments',
  'List all departments/locations from iiko.',
  {},
  async () => {
    if (!iikoClient) return iikoNotConfigured();
    try {
      const data = await iikoClient.request('GET', '/corporation/departments');
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return iikoError(err);
    }
  },
);

server.tool(
  'iiko_products',
  'Get the product catalog (menu items, ingredients, etc.) from iiko.',
  {},
  async () => {
    if (!iikoClient) return iikoNotConfigured();
    try {
      const data = await iikoClient.request('GET', '/products');
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return iikoError(err);
    }
  },
);

server.tool(
  'iiko_suppliers',
  'List all suppliers from iiko.',
  {},
  async () => {
    if (!iikoClient) return iikoNotConfigured();
    try {
      const data = await iikoClient.request('GET', '/suppliers');
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return iikoError(err);
    }
  },
);

server.tool(
  'iiko_employees',
  'List all employees from iiko.',
  {},
  async () => {
    if (!iikoClient) return iikoNotConfigured();
    try {
      const data = await iikoClient.request('GET', '/employees');
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return iikoError(err);
    }
  },
);
```

- [ ] **Step 6: Verify it compiles**

```bash
cd container/agent-runner && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat: register 7 iiko tools in nanoclaw MCP server"
```

---

### Task 5: Build, verify, and smoke test

**Files:**
- None (verification only)

- [ ] **Step 1: Full build**

```bash
cd /Users/romae/nanoclaw && npm run build
```

Expected: successful compilation of both main project and agent-runner.

- [ ] **Step 2: Smoke test iiko auth directly**

```bash
curl -sS -X POST "https://bar-zebitlz.iiko.it/resto/api/auth?login=otchet&pass=73603ec2e1828e6b384c2c5ecfb95146db74b786"
```

Expected: returns a token string. Save it for the next step.

- [ ] **Step 3: Smoke test OLAP columns endpoint**

```bash
KEY=<token from step 2>
curl -sS "https://bar-zebitlz.iiko.it/resto/api/v2/reports/olap/columns?key=${KEY}&reportType=SALES" | head -c 500
```

Expected: JSON with field definitions.

- [ ] **Step 4: Logout to free license**

```bash
curl -sS "https://bar-zebitlz.iiko.it/resto/api/logout?key=${KEY}"
```

- [ ] **Step 5: Commit all together**

```bash
git add -A && git commit -m "feat: iiko MCP tools — complete implementation"
```
