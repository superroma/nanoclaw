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

    const body = new URLSearchParams({ login: this.login, pass: this.passHash });
    const res = await fetch(`${this.baseUrl}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
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
