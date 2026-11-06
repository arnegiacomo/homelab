// Where a digest goes: Discord, its Homepage tile (the ConfigMap digest-latest), and its numbers for the next run (the
// ConfigMap digest-state).
import { env, fetchJson } from "./common.ts";

const SERVICE_ACCOUNT = "/var/run/secrets/kubernetes.io/serviceaccount";

// With DRY_RUN set, postDiscord, publishTile and saveState print what they would send instead, and
// loadState reads nothing, for trying a digest from a laptop.
const dryRun = Boolean(process.env.DRY_RUN);

export type Attachment = { name: string; data: Blob };

// postDiscord posts to the webhook in DISCORD_WEBHOOK, with an optional file, e.g. an image. Discord's limit is 2000
// characters, and mentions are off. With a file, Discord wants multipart form data with the message as payload_json.
export async function postDiscord(content: string, file?: Attachment): Promise<void> {
  if (dryRun) return void console.log(`--- Discord${file ? ` (with ${file.name}, ${file.data.size} bytes)` : ""}\n${content}`);
  const message = JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: [] } });
  let body: BodyInit = message;
  if (file) {
    const form = new FormData();
    form.append("payload_json", message);
    form.append("files[0]", file.data, file.name);
    body = form;
  }
  const res = await fetch(env("DISCORD_WEBHOOK"), {
    method: "POST",
    headers: file ? {} : { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Discord: ${res.status} ${await res.text()}`);
}

// kube calls the Kubernetes API as the job's ServiceAccount, in its own namespace. The ServiceAccount may only get
// and patch the ConfigMaps digest-latest and digest-state. NODE_EXTRA_CA_CERTS points at the cluster CA.
async function kube<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = (await Bun.file(`${SERVICE_ACCOUNT}/token`).text()).trim();
  const namespace = (await Bun.file(`${SERVICE_ACCOUNT}/namespace`).text()).trim();
  return fetchJson<T>("Kubernetes", `https://kubernetes.default.svc/api/v1/namespaces/${namespace}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/merge-patch+json" },
  });
}

function patchConfigMap(name: string, key: string, value: string): Promise<unknown> {
  return kube(`configmaps/${name}`, { method: "PATCH", body: JSON.stringify({ data: { [key]: value } }) });
}

// publishTile writes a digest's tile values as JSON into the ConfigMap digest-latest, under <name>.json, which
// digest-web serves to Homepage. The values are short strings, one per block.
export async function publishTile(name: string, values: Record<string, string>): Promise<void> {
  const json = JSON.stringify(values);
  if (dryRun) return void console.log(`--- ${name}.json\n${json}`);
  await patchConfigMap("digest-latest", `${name}.json`, json);
}

// loadState and saveState keep a digest's numbers from one run to the next, as JSON in the ConfigMap digest-state.
export async function loadState<T>(key: string): Promise<T | null> {
  if (dryRun) return null;
  const configMap = await kube<{ data?: Record<string, string> }>("configmaps/digest-state");
  const value = configMap.data?.[key];
  return value ? (JSON.parse(value) as T) : null;
}

export async function saveState(key: string, value: object): Promise<void> {
  if (dryRun) return void console.log(`--- state ${key}\n${JSON.stringify(value)}`);
  await patchConfigMap("digest-state", key, JSON.stringify(value));
}
