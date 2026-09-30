import type { Config } from "./config.js";

export class InceptionApiError extends Error {
  constructor(
    public status: number,
    public path: string,
    public body: string,
  ) {
    super(`Inception API ${status} on ${path}: ${body.slice(0, 300)}`);
  }

  hint(): string | undefined {
    switch (this.status) {
      case 401:
        return "The API token was rejected. Regenerate it under Users > Credentials > User API Token and update INCEPTION_API_TOKEN.";
      case 403:
        return "The API user lacks permission for this item. Use the 'REST Web API User' web page profile and grant view access to the items you want visible.";
      case 404:
        return "Not found. Review events also need the user to have review access, and older firmware lacks some endpoints.";
      default:
        return undefined;
    }
  }
}

/**
 * Only these GET paths can ever be requested. There is deliberately no method
 * parameter and no way to send a body: the client cannot change anything on the panel.
 */
const ALLOWED_PATHS: RegExp[] = [
  /^\/api\/protocol-version$/,
  /^\/api\/v1\/system-info$/,
  /^\/api\/v1\/control\/(area|door|input|output)\/summary$/,
  /^\/api\/v1\/review$/,
];

export type Query = Record<string, string | number | undefined>;

export class InceptionClient {
  constructor(private cfg: Config) {}

  async get<T = unknown>(path: string, query: Query = {}): Promise<T> {
    if (!ALLOWED_PATHS.some((re) => re.test(path))) {
      throw new Error(`Path not permitted by this read-only client: ${path}`);
    }
    const url = new URL(this.cfg.inceptionUrl + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.requestTimeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `APIToken ${this.cfg.apiToken}`,
        },
        signal: ctrl.signal,
      });
    } catch (e: any) {
      if (e?.name === "AbortError") {
        throw new Error(`Timed out after ${this.cfg.requestTimeoutMs}ms contacting Inception at ${this.cfg.inceptionUrl}`);
      }
      throw new Error(`Could not reach Inception at ${this.cfg.inceptionUrl}: ${e?.cause?.code ?? e?.message ?? e}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) throw new InceptionApiError(res.status, path, text);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Inception returned non-JSON for ${path}: ${text.slice(0, 120)}`);
    }
  }

  async protocolVersion(): Promise<number> {
    const r = await this.get<{ ProtocolVersion: number }>("/api/protocol-version");
    return r.ProtocolVersion;
  }
}
