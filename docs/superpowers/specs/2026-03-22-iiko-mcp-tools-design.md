# iiko MCP Tools — Design Spec

## Summary

Add iiko restaurant management API tools to the existing nanoclaw MCP server (`ipc-mcp-stdio.ts`). This gives all NanoClaw agents the ability to query sales reports, product catalogs, employees, stores, and other read-only data from the iiko server at `bar-zebitlz.iiko.it`.

## iiko Server API

The target API is the on-premise iikoServer REST API at `https://{host}/resto/api/`. This is NOT the newer iikoCloud/Transport API (`/api/1/`).

**Authentication:** `POST /resto/api/auth` with `application/x-www-form-urlencoded` body (`login={login}&pass={passHash}`) returns a **plain-text** session token string. Each active token consumes one license slot — tokens must be released via `GET /resto/api/logout?key={token}`.

**Reference:** Full OLAP v2 API docs at `groups/../zbpages/Справочник/IIKO.md` and https://ru.iiko.help/articles/api-documentations/olap-otchety-v2

## Credentials

Store in `.env` (root of nanoclaw):

```
IIKO_HOST=bar-zebitlz.iiko.it
IIKO_LOGIN=otchet
IIKO_PASS_HASH=73603ec2e1828e6b384c2c5ecfb95146db74b786
```

### Flow

1. `readSecrets()` in `src/container-runner.ts` reads these from `.env` alongside existing secrets
2. They are passed via stdin to the agent-runner process as `containerInput.secrets`
3. Agent-runner merges them into `sdkEnv`
4. iiko env vars must be **explicitly** added to the `mcpServers.nanoclaw.env` block in `index.ts` (MCP subprocess env does not automatically inherit `sdkEnv`)

### Changes required

- **`src/container-runner.ts`**: Add `IIKO_HOST`, `IIKO_LOGIN`, `IIKO_PASS_HASH` to the `readSecrets()` allowlist
- **`container/agent-runner/src/index.ts`**: Pass iiko env vars in the MCP server's `env` block

## Auth Module

An `IikoClient` class in a new file `container/agent-runner/src/iiko-client.ts`:

```typescript
class IikoClient {
  private token: string | null = null;
  private host: string;
  private login: string;
  private passHash: string;

  constructor() {
    this.host = process.env.IIKO_HOST!;
    this.login = process.env.IIKO_LOGIN!;
    this.passHash = process.env.IIKO_PASS_HASH!;
  }

  async getToken(): Promise<string>  // login or return cached
  async request(method, path, body?): Promise<any>  // auto-retry on 401
  async logout(): Promise<void>  // release license slot
}
```

**Behavior:**
- `getToken()`: If cached token exists, return it. Otherwise call `POST /resto/api/auth` with `application/x-www-form-urlencoded` body. Response is a plain-text token string
- `request()`: Makes HTTP request with `?key={token}`. On 401, clears cached token, re-authenticates, retries once
- `logout()`: Calls `GET /resto/api/logout?key={token}` to release the license slot. Registered via `process.on('SIGTERM', () => { client.logout().finally(() => process.exit(0)); })`. Under SIGKILL the token will leak (unavoidable — iiko server will eventually expire it)
- If `IIKO_HOST` is not set, the client is not initialized and all iiko tools return "iiko not configured"
- Uses Node.js built-in `fetch()` — no additional HTTP client dependency needed

## MCP Tools

All tools are added to the existing `server` instance in `ipc-mcp-stdio.ts`.

### 1. `iiko_olap_report` — OLAP analytics query

The primary tool. Agents use this to answer questions about sales, revenue, orders, etc.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `report_type` | enum: SALES, TRANSACTIONS, DELIVERIES | yes | Type of OLAP report |
| `date_from` | string (YYYY-MM-DD) | yes | Start date |
| `date_to` | string (YYYY-MM-DD) | yes | End date |
| `group_by_rows` | string[] | yes | Fields to group by (e.g., `["DishName", "DayOfWeekOpen"]`) |
| `aggregate_fields` | string[] | yes | Fields to aggregate (e.g., `["DishSumInt", "UniqOrderId"]`) |
| `filters` | object (JSON) | no | Additional filters beyond the date range. Format matches iiko API filter structure |

**Implementation:** Builds the full request body with `OpenDate.Typed` DateRange filter from date_from/date_to, merges user-provided filters, adds standard exclusions (NOT_DELETED, exclude DELETED_WITH/WITHOUT_WRITEOFF, exclude storned). Calls `POST /resto/api/v2/reports/olap`.

**Returns:** The `data` array from the response (top-level `data` key in the JSON response object — see response format in IIKO.md reference).

### 2. `iiko_olap_columns` — Discover available report fields

Agents call this first to understand what fields are available for grouping, aggregation, and filtering.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `report_type` | enum: SALES, TRANSACTIONS, DELIVERIES | yes | Type of report |

**Implementation:** Calls `GET /resto/api/v2/reports/olap/columns?key={token}&reportType={type}`.

**Returns:** JSON object with field definitions (name, type, aggregationAllowed, groupingAllowed, filteringAllowed, tags).

### 3. `iiko_stores` — List stores/warehouses

**Parameters:** None

**Implementation:** `GET /resto/api/corporation/stores?key={token}`

### 4. `iiko_departments` — List departments/locations

**Parameters:** None

**Implementation:** `GET /resto/api/corporation/departments?key={token}`

### 5. `iiko_products` — Product catalog

**Parameters:** None (or optional `includeDeleted` boolean)

**Implementation:** `GET /resto/api/products?key={token}`

### 6. `iiko_suppliers` — Supplier list

**Parameters:** None

**Implementation:** `GET /resto/api/suppliers?key={token}`

### 7. `iiko_employees` — Employee list

**Parameters:** None

**Implementation:** `GET /resto/api/employees?key={token}`

## Permissions

Add `mcp__nanoclaw__iiko_*` to the `allowedTools` array in `container/agent-runner/src/index.ts` so all groups can use iiko tools without permission prompts.

## Files Changed

| File | Change |
|------|--------|
| `.env` | Add `IIKO_HOST`, `IIKO_LOGIN`, `IIKO_PASS_HASH` |
| `src/container-runner.ts` | Add iiko keys to `readSecrets()` allowlist |
| `container/agent-runner/src/index.ts` | Pass iiko env to MCP server, add `mcp__nanoclaw__iiko_*` to allowed tools |
| `container/agent-runner/src/iiko-client.ts` | **New file** — IikoClient class with auth management |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Import IikoClient, register 7 new tools |

## Error Handling

- If `IIKO_HOST` env var is not set, iiko tools return a clear error: "iiko integration not configured"
- HTTP errors from iiko API are returned as MCP tool errors with the status code and response body
- Auth failures (wrong credentials) surface as tool errors
- Network timeouts: 30-second timeout on all iiko requests

## Testing

- Manual: Run NanoClaw, send a message asking for sales data, verify the agent uses `iiko_olap_columns` then `iiko_olap_report`
- Verify token reuse: second tool call should not re-authenticate
- Verify logout: check iiko server shows freed license after agent process exits
- Verify non-OLAP endpoints return data (stores, departments, products, suppliers, employees)
