// Weekly advice for the maintainer of an open-source project, from every thread in GITHUB_REPOS (comma-separated):
// issues, pull requests and discussions, open and closed, with their comments and reviews. The maintainer is the
// owner of the first repo. It only reads from GitHub.
//
// It works in two steps. First the model summarizes each thread on its own, and the summary is kept in DATA_DIR, so
// a later run only reads the threads that changed. Then the model writes the report from all the summaries at once:
// open threads in full, closed ones as one line, plus each repo's README, its latest release notes and goals.md.
//
// The model picks and words the items. The code checks them: an item must cite threads that exist, the counts of
// people and reactions are computed here, and an item whose threads were all in an earlier report and haven't
// changed since is dropped.
//
// The report is DATA_DIR/report.html, which digest-web serves at REPORT_URL, with a short post to Discord.
import { mkdir } from "node:fs/promises";
import { chat, chatWithContext, github, graphql } from "./apis.ts";
import { env, today } from "./common.ts";
import { postDiscord } from "./output.ts";

const DATA = env("DATA_DIR");
const repos = env("GITHUB_REPOS").split(",");
const maintainer = repos[0].split("/")[0];
const shortName = (repo: string) => repo.split("/")[1];
const project = shortName(repos[0]);

// A thread's text is cut to fit the model's default context window with room for the answer.
const THREAD_CHARS = 30_000;
const POST_CHARS = 3_000;
const SYNTHESIS_CONTEXT = 32_768;
const MAX_ITEMS = 5;

type Person = { login: string; __typename: string } | null;
type Post = { author: Person; body: string };
type Raw = {
  title: string;
  url: string;
  state?: string;
  closed?: boolean;
  createdAt: string;
  updatedAt: string;
  author: Person;
  body: string;
  upvoteCount?: number;
  reactions: { totalCount: number };
  category?: { name: string };
  comments: { nodes: (Post & { replies?: { nodes: Post[] } })[] };
  files?: { nodes: { path: string }[] };
  reviews?: { nodes: (Post & { state: string })[] };
  reviewThreads?: { nodes: { comments: { nodes: (Post & { path: string })[] } }[] };
};

const AUTHOR = "author { login __typename }";
const KINDS = {
  issue: {
    list: "issues",
    one: `issue(number: N) { title url state createdAt updatedAt ${AUTHOR} body reactions { totalCount }
      comments(first: 100) { nodes { ${AUTHOR} body } } }`,
  },
  pr: {
    list: "pullRequests",
    one: `pullRequest(number: N) { title url state createdAt updatedAt ${AUTHOR} body reactions { totalCount }
      comments(first: 100) { nodes { ${AUTHOR} body } }
      files(first: 30) { nodes { path } }
      reviews(first: 50) { nodes { ${AUTHOR} body state } }
      reviewThreads(first: 50) { nodes { comments(first: 20) { nodes { ${AUTHOR} body path } } } } }`,
  },
  discussion: {
    list: "discussions",
    one: `discussion(number: N) { title url closed createdAt updatedAt ${AUTHOR} body upvoteCount reactions { totalCount }
      category { name }
      comments(first: 100) { nodes { ${AUTHOR} body replies(first: 50) { nodes { ${AUTHOR} body } } } } }`,
  },
} as const;
type Kind = keyof typeof KINDS;

type Summary = {
  gist: string;
  summary: string;
  topics: string[];
  stance: "accepted" | "declined" | "undecided" | "none";
  waitingOn: "maintainer" | "author" | "nobody";
};
// A thread as kept in DATA_DIR/threads. Issues, PRs and discussions share one number sequence in a repo, so
// repo#number names one thread.
type Thread = Summary & {
  repo: string;
  kind: Kind;
  number: number;
  title: string;
  url: string;
  state: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  people: string[];
  reactions: number;
};

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    gist: { type: "string" },
    summary: { type: "string" },
    topics: { type: "array", items: { type: "string" }, maxItems: 3 },
    stance: { enum: ["accepted", "declined", "undecided", "none"] },
    waitingOn: { enum: ["maintainer", "author", "nobody"] },
  },
  required: ["gist", "summary", "topics", "stance", "waitingOn"],
};

const SUMMARY_SYSTEM = `You read one thread from an open-source project and record it for its maintainer, ${maintainer}.
Use only what the thread says. Answer with JSON:
- gist: at most 15 words: what the author wants or proposes.
- summary: at most 70 words: what was asked or proposed, what was said about it, and where it ended or stands now. Name what blocks it, if anything.
- topics: 1 to 3 short lowercase tags for the subject, e.g. "installer", "e-ink panel", "artwork retouch". Use the plain word for a thing, so threads on the same subject get the same tag.
- stance: ${maintainer}'s position on what was asked: accepted, declined or undecided, or none when ${maintainer} hasn't said.
- waitingOn: who has to act next: maintainer, author, or nobody when the thread is finished.`;

const key = (t: { repo: string; number: number }) => `${t.repo}#${t.number}`;
const threadFile = (repo: string, number: number) => `${DATA}/threads/${repo}-${number}.json`;
const isBot = (p: Person) => p?.__typename === "Bot";
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)} [cut]` : text);

async function readJson<T>(path: string): Promise<T | null> {
  const file = Bun.file(path);
  return (await file.exists()) ? ((await file.json()) as T) : null;
}

// listThreads pages through every thread of one kind in a repo, with just enough to tell whether it changed.
async function listThreads(repo: string, kind: Kind): Promise<{ number: number; updatedAt: string; author: Person }[]> {
  const [owner, name] = repo.split("/");
  const query = `query($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      list: ${KINDS[kind].list}(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { number updatedAt ${AUTHOR} }
      }
    }
  }`;
  type Page = { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: { number: number; updatedAt: string; author: Person }[] };
  const all: Page["nodes"] = [];
  let after: string | null = null;
  do {
    const page: Page = (await graphql<{ repository: { list: Page } }>(query, { owner, name, after })).repository.list;
    all.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return all;
}

// keepWithin keeps the first posts and as many of the last as fit, since a long thread's start says what it's about
// and its end says where it stands.
function keepWithin(posts: string[], budget: number): string[] {
  if (posts.join("\n").length <= budget) return posts;
  const head = posts.slice(0, 3);
  let room = budget - head.join("\n").length;
  const tail: string[] = [];
  for (let i = posts.length - 1; i >= head.length && posts[i].length < room; i--) {
    tail.unshift(posts[i]);
    room -= posts[i].length;
  }
  return [...head, `[${posts.length - head.length - tail.length} posts left out]`, ...tail];
}

// readThread fetches one thread in full and has the model summarize it.
async function readThread(repo: string, kind: Kind, number: number): Promise<Thread> {
  const [owner, name] = repo.split("/");
  const query = `query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) { thread: ${KINDS[kind].one.replace("N", String(number))} }
  }`;
  const raw = (await graphql<{ repository: { thread: Raw } }>(query, { owner, name })).repository.thread;
  const state = raw.state?.toLowerCase() ?? (raw.closed ? "closed" : "open");

  const say = (p: Post, note = "") => `${p.author?.login ?? "ghost"}${note}: ${clip(p.body.trim(), POST_CHARS)}`;
  const comments = raw.comments.nodes.flatMap((c) => [c, ...(c.replies?.nodes ?? [])]);
  const reviews = (raw.reviews?.nodes ?? []).filter((r) => r.body.trim());
  const reviewComments = (raw.reviewThreads?.nodes ?? []).flatMap((t) => t.comments.nodes);
  const posts = [
    ...comments.map((c) => say(c)),
    ...reviews.map((r) => say(r, ` (review, ${r.state.toLowerCase()})`)),
    ...reviewComments.map((c) => say(c, ` (on ${c.path})`)),
  ];
  const text = [
    `${kind} #${number} in ${repo}, ${state}${raw.category ? `, category ${raw.category.name}` : ""}`,
    `Title: ${raw.title}`,
    `Opened ${raw.createdAt.slice(0, 10)} by ${raw.author?.login ?? "ghost"}, last activity ${raw.updatedAt.slice(0, 10)}`,
    ...(raw.files ? [`Files: ${raw.files.nodes.map((f) => f.path).join(", ")}`] : []),
    "",
    clip(raw.body.trim(), POST_CHARS * 2) || "(no description)",
    "",
    "POSTS",
    ...keepWithin(posts, THREAD_CHARS),
  ].join("\n");

  const summary = await chat<Summary>(SUMMARY_SYSTEM, text, SUMMARY_SCHEMA);
  const everyone = [raw, ...comments, ...reviews, ...reviewComments].map((p) => p.author);
  return {
    repo: name,
    kind,
    number,
    title: raw.title,
    url: raw.url,
    state,
    author: raw.author?.login ?? "ghost",
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    people: [...new Set(everyone.filter((p) => p && !isBot(p) && p.login !== maintainer).map((p) => p!.login))],
    reactions: raw.reactions.totalCount + (raw.upvoteCount ?? 0),
    ...summary,
  };
}

// Step 1: a summary of every thread. PRs from bots (Dependabot) are skipped.
await mkdir(`${DATA}/threads`, { recursive: true });
const threads = new Map<string, Thread>();
for (const repo of repos) {
  for (const kind of Object.keys(KINDS) as Kind[]) {
    for (const entry of await listThreads(repo, kind)) {
      if (kind === "pr" && isBot(entry.author)) continue;
      const file = threadFile(shortName(repo), entry.number);
      let thread = await readJson<Thread>(file);
      if (thread?.updatedAt !== entry.updatedAt) {
        thread = await readThread(repo, kind, entry.number);
        await Bun.write(file, JSON.stringify(thread));
        console.log(`read ${key(thread)}: ${thread.gist}`);
      }
      threads.set(key(thread), thread);
    }
  }
}
console.log(`${threads.size} threads`);

// Step 2: the report.
const SECTIONS = ["patterns", "direction", "housekeeping"] as const;
type Ref = { repo: string; number: number };
type Need = { thread: Ref; wants: string; status: string; next: string };
type Item = { title: string; text: string; threads: Ref[] };
type Report = { needsYou: Need[] } & Record<(typeof SECTIONS)[number], Item[]>;
// What earlier reports cited, per section, so an unchanged thread isn't brought up again.
type Reported = { generatedAt: string; cited: Record<keyof Report, string[]> };

const REF = {
  type: "object",
  properties: { repo: { enum: repos.map(shortName) }, number: { type: "integer" } },
  required: ["repo", "number"],
};
const items = {
  type: "array",
  maxItems: MAX_ITEMS,
  items: {
    type: "object",
    properties: { title: { type: "string" }, text: { type: "string" }, threads: { type: "array", items: REF, minItems: 1 } },
    required: ["title", "text", "threads"],
  },
};
const REPORT_SCHEMA = {
  type: "object",
  properties: {
    needsYou: {
      type: "array",
      maxItems: MAX_ITEMS,
      items: {
        type: "object",
        properties: { thread: REF, wants: { type: "string" }, status: { type: "string" }, next: { type: "string" } },
        required: ["thread", "wants", "status", "next"],
      },
    },
    patterns: items,
    direction: items,
    housekeeping: items,
  },
  required: ["needsYou", ...SECTIONS],
};

const REPORT_SYSTEM = `You advise ${maintainer}, the maintainer of an open-source project, once a week.
You are given every thread in the project's repos: issues, pull requests and discussions. Open threads come with a summary, closed ones with one line. A thread is written repo#number.
Base everything on the threads. Never invent a thread or a fact. Be concrete: name the feature, the bug or the page, not "improve the documentation".
A section with nothing worth the maintainer's time stays empty. An empty section is better than filler.
Cite threads in "thread" and "threads" only, by repo and number. Don't write thread numbers in the text.
Answer with JSON, at most ${MAX_ITEMS} items per section, the most important first:
- needsYou: open threads where the maintainer has to act next.
  - wants: what the person actually wants, at most 20 words.
  - status: where it stands, at most 20 words.
  - next: the next move you suggest, concrete, at most 25 words.
- patterns: what several threads have in common: the same request or bug from different people, a question that keeps coming back because the docs don't answer it, review feedback the maintainer keeps repeating. At least 2 threads each.
  - title: at most 8 words. text: at most 50 words: the pattern, and what would stop it from coming back.
- direction: what to build or decide next, judged by demand: how many different people ask, how many reactions, how recent.
  - Respect the maintainer's goals. Don't suggest what the maintainer declined (stance declined), unless demand has clearly grown since, and then say so.
  - title: at most 8 words. text: at most 50 words: what, and why now.
- housekeeping: open threads to close, mark as duplicates or nudge: stale, answered, superseded.
  - title: at most 8 words. text: at most 30 words: the action.
Threads listed under ALREADY REPORTED were in an earlier report and haven't changed since. Don't build an item on those alone.`;

const previous = await readJson<Reported>(`${DATA}/reported.json`);
const unchanged = (k: string) => previous != null && (threads.get(k)?.updatedAt ?? "") <= previous.generatedAt;
const alreadyCited = (section: keyof Report) => (previous?.cited[section] ?? []).filter(unchanged);

async function readme(repo: string): Promise<string> {
  const res = await github<{ content: string }>(`/repos/${repo}/readme`);
  return clip(Buffer.from(res.content, "base64").toString("utf8"), 6_000);
}
async function releases(repo: string): Promise<string> {
  const res = await github<{ tag_name: string; published_at: string; body: string | null }[]>(`/repos/${repo}/releases?per_page=3`);
  return res.map((r) => `${r.tag_name} (${r.published_at.slice(0, 10)}): ${clip(r.body ?? "", 1_000)}`).join("\n") || "none";
}

const counts = (t: Thread) => `${t.people.length} people, ${t.reactions} reactions`;
const open = [...threads.values()].filter((t) => t.state === "open");
const closed = [...threads.values()].filter((t) => t.state !== "open");
const sections = (
  await Promise.all(
    repos.map(async (repo) => [`README OF ${repo} (the start)\n${await readme(repo)}`, `LATEST RELEASES OF ${repo}\n${await releases(repo)}`]),
  )
).flat();

const facts = [
  `The maintainer is ${maintainer}. The repos are ${repos.join(" and ")}. Today is ${new Date().toISOString().slice(0, 10)}.`,
  `THE MAINTAINER'S GOALS\n${(await Bun.file(new URL("goals.md", import.meta.url)).text()).trim()}`,
  ...sections,
  `OPEN THREADS\n${open
    .map(
      (t) =>
        `${key(t)} ${t.kind} "${t.title}", opened ${t.createdAt.slice(0, 10)} by ${t.author}, last activity ${t.updatedAt.slice(0, 10)}, ` +
        `${counts(t)}, waiting on ${t.waitingOn}, maintainer stance ${t.stance}, topics: ${t.topics.join(", ")}\n  ${t.summary}`,
    )
    .join("\n")}`,
  `CLOSED THREADS\n${closed
    .map((t) => `${key(t)} ${t.kind} ${t.state} ${t.updatedAt.slice(0, 7)}, ${counts(t)}, stance ${t.stance}, [${t.topics.join(", ")}] ${t.gist}`)
    .join("\n")}`,
  `ALREADY REPORTED\n${[...new Set((Object.keys(REPORT_SCHEMA.properties) as (keyof Report)[]).flatMap(alreadyCited))].join(", ") || "none"}`,
].join("\n\n");
console.log(`report prompt: ${facts.length} characters`);

const answer = await chatWithContext<Report>(REPORT_SYSTEM, facts, REPORT_SCHEMA, SYNTHESIS_CONTEXT);
console.log(JSON.stringify(answer, null, 2));
// The larger context made Ollama reload the model. A call at the default size loads it back, so the next caller,
// e.g. Home Assistant's voice assistant, doesn't wait for that.
await chat<object>("Answer with an empty JSON object.", "{}", { type: "object" });

// check drops what the code can prove wrong: a cited thread that doesn't exist, and an item whose threads were all
// in an earlier report and haven't changed since. A thread only needs the maintainer when it's open and its own
// summary says it waits on the maintainer.
function check<T>(section: keyof Report, list: T[], refs: (item: T) => Ref[]): T[] {
  const seen = alreadyCited(section);
  return list.slice(0, MAX_ITEMS).filter((item) => {
    const keys = refs(item).map(key);
    const reason =
      keys.length === 0 ? "cites nothing" : keys.some((k) => !threads.has(k)) ? "cites a thread that doesn't exist" : keys.every((k) => seen.includes(k)) ? "already reported" : null;
    if (reason) console.log(`dropped from ${section}, ${reason}: ${JSON.stringify(item)}`);
    return !reason;
  });
}
const waitsOnMaintainer = (ref: Ref) => {
  const t = threads.get(key(ref))!;
  return t.state === "open" && t.waitingOn === "maintainer";
};
const once = (list: Item[]) => list.map((x) => ({ ...x, threads: x.threads.filter((r, i) => x.threads.findIndex((o) => key(o) === key(r)) === i) }));
const report: Report = {
  needsYou: check("needsYou", answer.needsYou, (x) => [x.thread]).filter((x) => waitsOnMaintainer(x.thread)),
  patterns: check("patterns", once(answer.patterns), (x) => x.threads),
  direction: check("direction", once(answer.direction), (x) => x.threads),
  housekeeping: check("housekeeping", once(answer.housekeeping), (x) => x.threads),
};

const esc = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const label = (t: Thread) => `${t.repo === project ? "" : t.repo}#${t.number}`;
const link = (ref: Ref) => {
  const t = threads.get(key(ref))!;
  return `<a href="${esc(t.url)}" title="${esc(t.title)}">${esc(label(t))}</a>`;
};
// The people behind an item are counted once each across its threads. The maintainer is never counted.
const backing = (refs: Ref[]) => {
  const cited = refs.map((r) => threads.get(key(r))!);
  return `${new Set(cited.flatMap((t) => t.people)).size} people · ${cited.reduce((sum, t) => sum + t.reactions, 0)} reactions`;
};
const section = (title: string, body: string[]) => (body.length ? `<h2>${title}</h2>\n${body.join("\n")}` : "");
const itemHtml = (x: Item) =>
  `<article><h3>${esc(x.title)}</h3><p>${esc(x.text)}</p><p class="meta">${backing(x.threads)} · ${x.threads.map(link).join(" ")}</p></article>`;

const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(project)} advice</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; border-bottom: 1px solid #8884; }
  h3 { font-size: 1rem; margin: 1.2rem 0 0.2rem; } p { margin: 0.2rem 0; }
  dl { margin: 0.2rem 0; display: grid; grid-template-columns: 4rem 1fr; } dt { opacity: 0.6; } dd { margin: 0; }
  .meta { font-size: 0.85rem; opacity: 0.7; }
</style>
<h1>${esc(project)} advice · ${esc(today())}</h1>
<p class="meta">From ${threads.size} threads in ${repos.map(esc).join(" and ")}, ${open.length} of them open.</p>
${[
  section(
    "Needs you",
    report.needsYou.map((x) => {
      const t = threads.get(key(x.thread))!;
      return `<article><h3>${link(x.thread)} ${esc(t.title)}</h3><dl><dt>Wants</dt><dd>${esc(x.wants)}</dd><dt>Status</dt><dd>${esc(x.status)}</dd><dt>Next</dt><dd>${esc(x.next)}</dd></dl><p class="meta">${backing([x.thread])}</p></article>`;
    }),
  ),
  section("Patterns", report.patterns.map(itemHtml)),
  section("Direction", report.direction.map(itemHtml)),
  section("Housekeeping", report.housekeeping.map(itemHtml)),
]
  .filter(Boolean)
  .join("\n") || "<p>Nothing new this week.</p>"}
`;
await Bun.write(`${DATA}/report.html`, html);

const cited: Reported["cited"] = {
  needsYou: [...new Set([...alreadyCited("needsYou"), ...report.needsYou.map((x) => key(x.thread))])],
  patterns: [...new Set([...alreadyCited("patterns"), ...report.patterns.flatMap((x) => x.threads.map(key))])],
  direction: [...new Set([...alreadyCited("direction"), ...report.direction.flatMap((x) => x.threads.map(key))])],
  housekeeping: [...new Set([...alreadyCited("housekeeping"), ...report.housekeeping.flatMap((x) => x.threads.map(key))])],
};
await Bun.write(`${DATA}/reported.json`, JSON.stringify({ generatedAt: new Date().toISOString(), cited } satisfies Reported));

// Discord: the first two items of each section, and the link to the page.
const needLine = (x: Need) => {
  const t = threads.get(key(x.thread))!;
  return `[${label(t)}](<${t.url}>) ${x.next}`;
};
const top = (title: string, lines: string[]) => (lines.length ? [`**${title}**`, ...lines.slice(0, 2).map((l) => `- ${l}`)] : []);
const total = report.needsYou.length + SECTIONS.reduce((sum, s) => sum + report[s].length, 0);
await postDiscord(
  [
    `🧭 **${project}** · weekly advice · ${today()}`,
    ...(total === 0 ? ["Nothing new this week."] : []),
    ...top("Needs you", report.needsYou.map(needLine)),
    ...top("Patterns", report.patterns.map((x) => x.title)),
    ...top("Direction", report.direction.map((x) => x.title)),
    ...top("Housekeeping", report.housekeeping.map((x) => x.title)),
    `<${env("REPORT_URL")}>`,
  ].join("\n"),
);
