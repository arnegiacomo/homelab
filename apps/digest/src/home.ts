// The home digest: what changed in the homelab in the last 24h, what the cluster saw, and today's weather.
// Every fact is fetched here. The model only sorts and words them, as JSON, and the code renders that for Discord.
// The Homepage tile is worked out in code: the weather and the outages worth knowing the next morning.
import { chat, github, query, weather, weatherLine, type Sample } from "./apis.ts";
import { env, today } from "./common.ts";
import { postDiscord, publishTile } from "./output.ts";

type Commit = { sha: string; commit: { message: string; author: { name: string } }; author: { login: string } | null };

const KINDS = {
  firing: { icon: "🔴" },
  outage: { icon: "🟠" },
  blip: { icon: "🟡" },
  restart: { icon: "🔁" },
  reboot: { icon: "🔄" },
  temperature: { icon: "🌡️" },
  disk: { icon: "💾" },
} as const;

type Digest = {
  changes: { issue: number; deps: boolean; text: string }[];
  cluster: { kind: keyof typeof KINDS; text: string }[];
};

const SCHEMA = {
  type: "object",
  properties: {
    changes: {
      type: "array",
      items: {
        type: "object",
        properties: { issue: { type: "integer" }, deps: { type: "boolean" }, text: { type: "string" } },
        required: ["issue", "deps", "text"],
      },
    },
    cluster: {
      type: "array",
      items: {
        type: "object",
        properties: { kind: { enum: Object.keys(KINDS) }, text: { type: "string" } },
        required: ["kind", "text"],
      },
    },
  },
  required: ["changes", "cluster"],
};

const SYSTEM = `You sort and summarize the last 24 hours of a homelab for its owner's morning digest.
Use only the facts you are given. Never add anything that isn't in them.
Answer with JSON:
- changes: what changed, from the commits.
  - One item per issue number: merge the commits of one issue, and never put two issue numbers in one item. issue is that number (#38 is 38). A commit without an issue number is its own item, with issue 0.
  - text says what changed in at most 7 words, starting lowercase, without the issue number. For example "model server setup script", "back up PVCs to the USB disk".
  - All dependency updates (Renovate, "chore(deps)", merges of renovate/ branches) are one item with deps true and issue 0. text names what was updated and the version, e.g. "fugleramme 0.30.0".
  - At most 6 items, the dependency item last. With more, merge the smallest changes.
  - Empty when there are no commits.
- cluster: notable events, most serious first.
  - kind: firing (an alert still firing), outage (down over 15 minutes), blip (shorter outages, all in one item that names every one of them), restart (pod restarts), reboot, temperature (SoC over 70 °C), disk (over 80% full).
  - text is at most 8 words: what, how long, and whether it's over. For example "model server down 95 min, back up", "fugleramme 3 min, Pi-hole DNS 1 min". An alert and the outage it was about are one item.
  - Use the names as given. llm is the model server.
  - Empty when nothing is notable.`;

const since = new Date(Date.now() - 24 * 3600 * 1000);
const repo = env("GITHUB_REPO");
const ignoredAlerts = "Watchdog|InfoInhibitor";
// The tile counts a probe outage from this many minutes. The probe alerts are left out there, since they repeat it.
const TILE_OUTAGE_MINUTES = 15;
const probeAlerts = new Set(["ProbeFailed", "PiholeDown"]);

const [commits, alerts, firing, outages, restarts, reboots, temperature, disk, forecast] = await Promise.all([
  github<Commit[]>(`/repos/${repo}/commits?sha=main&since=${since.toISOString()}&per_page=100`),
  query(`max_over_time(ALERTS{alertstate="firing",alertname!~"${ignoredAlerts}"}[24h])`),
  query(`ALERTS{alertstate="firing",alertname!~"${ignoredAlerts}"}`),
  // Minutes down per probe target: every minute of the last 24h where the probe failed.
  query("sum_over_time((probe_success == bool 0)[24h:1m]) >= 1"),
  query("sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total[24h])) >= 1"),
  query("changes(node_boot_time_seconds[24h]) > 0"),
  query('max_over_time(node_thermal_zone_temp{job="node-exporter",type="cpu-thermal"}[24h])'),
  query(
    'max_over_time((100 * (1 - node_filesystem_avail_bytes{job="node-exporter",mountpoint="/"} / node_filesystem_size_bytes{job="node-exporter",mountpoint="/"}))[24h:5m])',
  ),
  weather(env("WEATHER_LAT"), env("WEATHER_LON")),
]);

const alertLabels = ["device", "instance", "namespace", "pod", "name", "job_name"];
const describe = (s: Sample) =>
  [s.metric.alertname, ...alertLabels.filter((l) => s.metric[l]).map((l) => `${l}=${s.metric[l]}`)].join(" ");
const stillFiring = new Set(firing.map(describe));
// A probe target's name: its device label, Pi-hole for the DNS probes, else the host of the URL.
const target = (m: Record<string, string>) =>
  m.device ?? (m.job.startsWith("dns-") ? "Pi-hole DNS" : m.instance.replace(/^https?:\/\//, "").replace(/[:/].*$/, ""));
const value = (samples: Sample[]) => (samples[0] ? Number(samples[0].value[1]).toFixed(0) : "unknown");

const facts = `Commits on main in the last 24h (${commits.length}):
${commits.map((c) => `- ${c.commit.message.split("\n")[0]} (${c.author?.login ?? c.commit.author.name})`).join("\n") || "none"}

Alerts that fired in the last 24h:
${alerts.map((a) => `- ${describe(a)} (${stillFiring.has(describe(a)) ? "still firing" : "resolved"})`).join("\n") || "none"}

Probe outages in the last 24h:
${outages.map((o) => `- ${target(o.metric)} (${o.metric.instance}): ${Number(o.value[1])} minutes down`).join("\n") || "none"}

Pod restarts in the last 24h:
${restarts.map((r) => `- ${r.metric.namespace}/${r.metric.pod}: ${Math.round(Number(r.value[1]))}`).join("\n") || "none"}

Reboots in the last 24h:
${reboots.map((r) => `- ${r.metric.job === "llm" ? "llm (model server)" : "homelab (k3s node)"}`).join("\n") || "none"}

homelab peaks in the last 24h: SoC temperature ${value(temperature)} °C, disk / ${value(disk)}% full.`;

console.log(facts);
const digest = await chat<Digest>(SYSTEM, facts, SCHEMA);
console.log(JSON.stringify(digest, null, 2));

const issueUrl = (n: number) => `https://github.com/${repo}/issues/${n}`;
const changeIcon = (c: Digest["changes"][number]) => (c.deps ? "📦" : "🔧");

// The tile: today's weather, and the longest outage plus a count of the rest. An outage is a fired alert or a probe
// down for TILE_OUTAGE_MINUTES or more, longest first. A target with several probes counts once, at its longest.
const downMinutes = new Map<string, number>();
for (const o of outages) {
  const name = target(o.metric);
  downMinutes.set(name, Math.max(downMinutes.get(name) ?? 0, Number(o.value[1])));
}
const tileOutages = [
  ...[...downMinutes]
    .filter(([, minutes]) => minutes >= TILE_OUTAGE_MINUTES)
    .sort((a, b) => b[1] - a[1])
    .map(([name, minutes]) => `${name} ${minutes} min`),
  ...new Set(alerts.map((a) => a.metric.alertname).filter((name) => !probeAlerts.has(name))),
];
await publishTile("home", {
  weather: `${forecast.sky[0] ?? ""} ${forecast.min}–${forecast.max} °C`.trim(),
  rain: forecast.rain >= 0.1 ? `${forecast.rain.toFixed(1)} mm` : "none",
  wind: `${forecast.wind} m/s`,
  outages: tileOutages.length
    ? `🔴 ${tileOutages[0]}${tileOutages.length > 1 ? ` +${tileOutages.length - 1}` : ""}`
    : "none",
});

// Discord: the same content as text. Issue links are in <> so Discord doesn't add a preview card.
const changeLines = digest.changes.map(
  (c) => `${changeIcon(c)} ${c.issue ? `[#${c.issue}](<${issueUrl(c.issue)}>) ` : ""}${c.text}`,
);
const clusterLines = digest.cluster.map((e) => `${KINDS[e.kind].icon} ${e.text}`);
await postDiscord(
  [
    `📰 **Home digest** · ${today()}`,
    weatherLine(forecast),
    "",
    "**Changes**",
    ...(changeLines.length ? changeLines : ["💤 Nothing new"]),
    "",
    "**Cluster**",
    ...(clusterLines.length ? clusterLines : ["✅ All quiet"]),
  ].join("\n"),
);
