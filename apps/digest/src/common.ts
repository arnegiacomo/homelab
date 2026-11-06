// What every digest file uses: env, fetch and the local time zone.
// Plain fetch, no npm dependencies. Config comes from env, set on each CronJob.

export const USER_AGENT = "homelab-digest github.com/arnegiacomo/homelab";
export const TIME_ZONE = "Europe/Oslo";

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// fetchJson throws on a non-2xx status. Error messages leave out the URL, since a webhook URL is a secret.
export async function fetchJson<T>(what: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000), ...init });
  if (!res.ok) throw new Error(`${what}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export function today(): string {
  return new Date().toLocaleDateString("en-GB", { timeZone: TIME_ZONE, weekday: "long", day: "numeric", month: "long" });
}
