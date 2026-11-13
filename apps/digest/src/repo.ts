// The digest for one open-source project: what needs the maintainer, what happened in the last 24h, and the numbers.
// GITHUB_REPO is the main repo, and the maintainer is its owner. It only reads from GitHub. Every fact is fetched
// here. The model only sorts and words the "needs you" and activity items, as JSON. The code renders the numbers,
// with the change since the last run from digest-state.
//
// Optional env: GITHUB_EXTRA_REPOS, more repos (comma-separated) whose items join the same lists, without numbers.
// GITHUB_PACKAGE, a container package whose pulls to count. ARTWORK_PREFIX, a PR title prefix in the main repo
// (e.g. "#33 add ") whose merged PRs are grouped into one line.
import { chat, github, graphql } from "./apis.ts";
import { env, today } from "./common.ts";
import { loadState, postDiscord, saveState } from "./output.ts";

const DAY = 24 * 3600 * 1000;
const repo = env("GITHUB_REPO");
const [owner, name] = repo.split("/");
const extraRepos = process.env.GITHUB_EXTRA_REPOS?.split(",") ?? [];
const pkg = process.env.GITHUB_PACKAGE;
const since = Date.now() - DAY;
const stateKey = `${name}.json`;
const shortName = (r: string) => r.split("/")[1];

type User = { login: string } | null;
type Pull = {
  number: number;
  title: string;
  user: User;
  draft: boolean;
  created_at: string;
  merged_at: string | null;
  author_association: string;
};
type Issue = { number: number; title: string; user: User; created_at: string; pull_request?: object };
type Release = { tag_name: string; published_at: string };
type Run = { name: string; workflow_id: number; status: string; conclusion: string | null };
type Day = { timestamp: string; count: number; uniques: number };
type Discussion = {
  number: number;
  title: string;
  createdAt: string;
  closed: boolean;
  author: User;
  comments: { nodes: { author: User; replies: { nodes: { author: User }[] } }[] };
};
type State = { stars: number; forks: number; pulls: number | null };

const DISCUSSIONS = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    discussions(first: 50, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number title createdAt closed author { login }
        comments(first: 50) { nodes { author { login } replies(first: 50) { nodes { author { login } } } } }
      }
    }
  }
}`;

// GHCR has no API for download counts, so this reads "Total downloads" from the public package page.
// The page can change at any time, so a failure means "pulls unavailable", not a failed digest.
async function packagePulls(): Promise<number | null> {
  if (!pkg) return null;
  try {
    const res = await fetch(`https://github.com/${owner}/${name}/pkgs/container/${pkg}`, {
      signal: AbortSignal.timeout(30_000),
    });
    const match = (await res.text()).match(/Total downloads<\/span>\s*<h3 title="(\d+)"/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

const isOwner = (u: User) => u?.login === owner;
const isBot = (u: User) => Boolean(u?.login.endsWith("[bot]"));
const olderThanADay = (iso: string) => Date.parse(iso) < since;
const age = (iso: string) => {
  const days = Math.floor((Date.now() - Date.parse(iso)) / DAY);
  return days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
};

const pr = (p: Pull) => `#${p.number} "${p.title}" by ${p.user?.login}, opened ${age(p.created_at)}`;
const issue = (i: Issue) => `#${i.number} "${i.title}" by ${i.user?.login}, opened ${age(i.created_at)}`;
const discussion = (d: Discussion) => `#${d.number} "${d.title}" by ${d.author?.login}, opened ${age(d.createdAt)}`;

// gather fetches one repo's items, each as a line of facts that starts with the repo's short name.
async function gather(repo: string, artworkPrefix?: string) {
  const [owner, name] = repo.split("/");
  const info = await github<{ stargazers_count: number; forks_count: number; default_branch: string }>(`/repos/${repo}`);
  const [openPulls, closedPulls, openIssues, recentIssues, releases, runs, discussions] = await Promise.all([
    github<Pull[]>(`/repos/${repo}/pulls?state=open&per_page=100`),
    github<Pull[]>(`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`),
    github<Issue[]>(`/repos/${repo}/issues?state=open&per_page=100`),
    github<Issue[]>(`/repos/${repo}/issues?state=all&since=${new Date(since).toISOString()}&per_page=100`),
    github<Release[]>(`/repos/${repo}/releases?per_page=10`),
    github<{ workflow_runs: Run[] }>(`/repos/${repo}/actions/runs?branch=${info.default_branch}&event=push&per_page=50`),
    graphql<{ repository: { discussions: { nodes: Discussion[] } } }>(DISCUSSIONS, { owner, name }).then(
      (d) => d.repository.discussions.nodes,
    ),
  ]);

  // Needs you: PRs from others without a review from the maintainer, issues and discussions from others that the
  // maintainer hasn't replied to within a day, and workflows whose latest run on the default branch failed.
  const reviewable = openPulls.filter((p) => !p.draft && !isOwner(p.user));
  const reviews = await Promise.all(reviewable.map((p) => github<{ user: User }[]>(`/repos/${repo}/pulls/${p.number}/reviews`)));
  const unreviewed = reviewable.filter((_, i) => !reviews[i].some((r) => isOwner(r.user)));

  const waitingIssues = openIssues.filter((i) => !i.pull_request && !isOwner(i.user) && olderThanADay(i.created_at));
  const comments = await Promise.all(
    waitingIssues.map((i) => github<{ user: User }[]>(`/repos/${repo}/issues/${i.number}/comments?per_page=100`)),
  );
  const unansweredIssues = waitingIssues.filter((_, i) => !comments[i].some((c) => isOwner(c.user)));

  const unansweredDiscussions = discussions.filter(
    (d) =>
      !d.closed &&
      !isOwner(d.author) &&
      olderThanADay(d.createdAt) &&
      !d.comments.nodes.some((c) => isOwner(c.author) || c.replies.nodes.some((r) => isOwner(r.author))),
  );

  const latestRuns = new Map<number, Run>();
  for (const run of runs.workflow_runs) {
    if (run.status === "completed" && !latestRuns.has(run.workflow_id)) latestRuns.set(run.workflow_id, run);
  }
  const failing = [...latestRuns.values()].filter((r) => r.conclusion === "failure");

  // Activity in the last 24h. A merged PR's author_association no longer says first-timer, so a merged PR counts as
  // a first contribution when it's its author's only merged PR in the repo.
  const merged = closedPulls.filter((p) => p.merged_at && Date.parse(p.merged_at) >= since);
  const artwork = artworkPrefix ? merged.filter((p) => p.title.startsWith(artworkPrefix)) : [];
  const authors = [...new Set(merged.filter((p) => !isOwner(p.user) && !isBot(p.user)).map((p) => p.user!.login))];
  const mergedCounts = await Promise.all(
    authors.map((a) =>
      github<{ total_count: number }>(`/search/issues?q=${encodeURIComponent(`repo:${repo} is:pr is:merged author:${a}`)}`),
    ),
  );
  const firstTimers = [
    ...authors.filter((_, i) => mergedCounts[i].total_count === 1),
    ...openPulls
      .filter((p) => Date.parse(p.created_at) >= since && ["FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER"].includes(p.author_association))
      .map((p) => p.user!.login),
  ];

  const tag = (lines: string[]) => lines.map((line) => `- ${name} ${line}`);
  return {
    info,
    unreviewed: tag(unreviewed.map(pr)),
    unansweredIssues: tag(unansweredIssues.map(issue)),
    unansweredDiscussions: tag(unansweredDiscussions.map(discussion)),
    failing: tag(failing.map((r) => r.name)),
    merged: tag(merged.filter((p) => !artwork.includes(p)).map((p) => `#${p.number} "${p.title}" by ${p.user?.login}`)),
    artwork: artwork.map((p) => p.title.slice(artworkPrefix?.length ?? 0)),
    newIssues: tag(recentIssues.filter((i) => !i.pull_request && Date.parse(i.created_at) >= since).map(issue)),
    newDiscussions: tag(discussions.filter((d) => Date.parse(d.createdAt) >= since).map(discussion)),
    releases: tag(releases.filter((r) => Date.parse(r.published_at) >= since).map((r) => r.tag_name)),
    firstTimers: tag(firstTimers),
  };
}

const [main, ...extras] = await Promise.all([gather(repo, process.env.ARTWORK_PREFIX), ...extraRepos.map((r) => gather(r))]);
const all = [main, ...extras];
const [views, pulls, state] = await Promise.all([
  github<{ views?: Day[] }>(`/repos/${repo}/traffic/views`),
  packagePulls(),
  loadState<State>(stateKey),
]);

// Numbers, for the main repo. Traffic is counted per UTC day, so "yesterday" is the last complete day.
const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
const viewsYesterday = views.views?.find((d) => d.timestamp.startsWith(yesterday)) ?? { count: 0, uniques: 0 };
const now: State = {
  stars: main.info.stargazers_count,
  forks: main.info.forks_count,
  pulls: pulls ?? state?.pulls ?? null,
};

const n = (value: number) => value.toLocaleString("en-US");
// delta is the change since the last run, e.g. " (+2)", or nothing on the first run.
const delta = (value: number, previous: number | null | undefined) => {
  if (previous == null) return "";
  const d = value - previous;
  return ` (${d > 0 ? "+" : d < 0 ? "−" : "±"}${n(Math.abs(d))})`;
};
const numbers = [
  `⭐ ${n(now.stars)}${delta(now.stars, state?.stars)}`,
  `🍴 ${n(now.forks)}${delta(now.forks, state?.forks)}`,
  pulls == null ? "🐳 pulls unavailable" : `🐳 ${n(pulls)} pulls${delta(pulls, state?.pulls)}`,
  `👀 ${n(viewsYesterday.count)} views, ${n(viewsYesterday.uniques)} unique yesterday`,
].join(" · ");

const list = (lines: string[]) => lines.slice(0, 10).join("\n") + (lines.length > 10 ? `\n- and ${lines.length - 10} more` : "") || "none";
const every = (key: Exclude<keyof typeof main, "info" | "artwork">) => list(all.flatMap((r) => r[key]));

const facts = `The maintainer is ${owner}. The repos are ${[repo, ...extraRepos].join(" and ")}. Every item starts with its repo.

NEEDS YOU
Open PRs from others without a review from the maintainer:
${every("unreviewed")}

Issues from others with no reply from the maintainer after a day:
${every("unansweredIssues")}

Discussions from others with no reply from the maintainer after a day:
${every("unansweredDiscussions")}

Workflows failing on the default branch:
${every("failing")}

ACTIVITY IN THE LAST 24H
Releases:
${every("releases")}

First-time contributors:
${every("firstTimers")}

Merged PRs:
${every("merged")}

Artwork PRs merged in ${name} (${main.artwork.length}): ${main.artwork.join(", ") || "none"}

New issues:
${every("newIssues")}

New discussions:
${every("newDiscussions")}`;

const NEEDS = {
  ci: { icon: "❌", path: "actions" },
  pr: { icon: "🔀", path: "pull" },
  issue: { icon: "🐛", path: "issues" },
  discussion: { icon: "💬", path: "discussions" },
} as const;
const ACTIVITY = {
  release: { icon: "🚀", path: "releases" },
  contributor: { icon: "🎉", path: "pull" },
  merged: { icon: "✅", path: "pull" },
  artwork: { icon: "🎨", path: "pulls" },
  issue: { icon: "🆕", path: "issues" },
  discussion: { icon: "💬", path: "discussions" },
} as const;

type Item<Kind> = { repo: string; kind: Kind; number: number; text: string };
type Digest = { needs: Item<keyof typeof NEEDS>[]; activity: Item<keyof typeof ACTIVITY>[] };

const item = (kinds: string[]) => ({
  type: "array",
  items: {
    type: "object",
    properties: {
      repo: { enum: [repo, ...extraRepos].map(shortName) },
      kind: { enum: kinds },
      number: { type: "integer" },
      text: { type: "string" },
    },
    required: ["repo", "kind", "number", "text"],
  },
});
const SCHEMA = {
  type: "object",
  properties: { needs: item(Object.keys(NEEDS)), activity: item(Object.keys(ACTIVITY)) },
  required: ["needs", "activity"],
};

const SYSTEM = `You sort and summarize a day in an open-source project for its maintainer's morning digest.
Use only the facts you are given. Never add anything that isn't in them.
Answer with JSON:
- needs: one item per thing under NEEDS YOU. Most urgent first: failing workflows, then PRs, issues and discussions, oldest first.
  - repo is the repo the item starts with.
  - kind: ci, pr, issue or discussion. number is its number, or 0 for a workflow.
  - text is at most 8 words: the gist of the title, who, and how long ago. For example "bird sounds missing at night, vmw, 3 days".
  - At most 8 items. If there are more, the last item says how many more of what, with number 0.
- activity: one item per thing under ACTIVITY IN THE LAST 24H. Releases first, then first-time contributors, merged PRs, artwork, new issues and new discussions.
  - repo is the repo the item starts with.
  - kind: release, contributor, merged, artwork, issue or discussion. number is the PR, issue or discussion number, or 0.
  - Artwork PRs are one item with kind artwork and number 0, e.g. "5 artwork PRs: winter wren, Sturnella magna, ...".
  - text is at most 10 words. For a contributor: who and what they contributed.
  - At most 8 items.
- Leave a list empty when its section says none.`;

console.log(facts);
const digest = await chat<Digest>(SYSTEM, facts, SCHEMA);
console.log(JSON.stringify(digest, null, 2));

// An item links to its number in its repo. Items from the extra repos say which repo.
const fullName = (short: string) => [repo, ...extraRepos].find((r) => shortName(r) === short) ?? repo;
const line = (x: Item<string>, icon: string, path: string, linked: boolean) => {
  const label = x.repo === name ? "" : x.repo;
  const url = `https://github.com/${fullName(x.repo)}/${path}${linked ? `/${x.number}` : ""}`;
  return `${icon} ${x.number ? `[${label}#${x.number}](<${url}>) ` : label && `${label}: `}${x.text}`;
};

// Discord: one message, sections left out when empty, links in <> so Discord doesn't add preview cards.
// A quiet day is one line.
const header = `🐙 **${name}** · ${today()}`;
const lines =
  digest.needs.length + digest.activity.length === 0
    ? [`${header} · quiet day · ${numbers}`]
    : [
        header,
        ...(digest.needs.length ? ["", "**Needs you**"] : []),
        ...digest.needs.map((x) => line(x, NEEDS[x.kind].icon, NEEDS[x.kind].path, x.kind !== "ci")),
        ...(digest.activity.length ? ["", "**Activity**"] : []),
        ...digest.activity.map((x) =>
          line(x, ACTIVITY[x.kind].icon, ACTIVITY[x.kind].path, x.kind !== "release" && x.kind !== "artwork"),
        ),
        "",
        "**Numbers**",
        numbers,
      ];
await postDiscord(lines.join("\n"));

await saveState(stateKey, now);
