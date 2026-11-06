// The bird digest, in Norwegian: which birds the frames at home heard yesterday, newcomers first, and a bird of the day
// with one fact from its Wikipedia article. Every fact is fetched here. The model only words the bird of the day's
// fact, from the article text it's given. The code renders everything else.
//
// Env: BIRD_STATIONS and BIRD_DATE (see birdnet.ts), and COLLAGE_FILE, the image of the day's birds posted with the
// digest, which fugleramme renders in the Job before this runs (see birdnet-proxy.ts).
import { chat } from "./apis.ts";
import { birdDate as date, birdnet, shiftDay, stations } from "./birdnet.ts";
import { env, fetchJson, TIME_ZONE, USER_AGENT } from "./common.ts";
import { loadState, postDiscord, publishTile, saveState } from "./output.ts";

const STATE_KEY = "birds.json";
// Discord rejects webhook files over 10 MB. A larger image is left out rather than failing the post.
const MAX_IMAGE = 9.5 * 1024 * 1024;
// A Norwegian article shorter than this has too little to pick a fact from, so the English one is used instead.
const MIN_ARTICLE = 500;

type Species = { scientific_name: string; common_name: string; count: number };
type Heard = { scientific: string; common: string; max: number; stations: string[]; counts: Record<string, number> };
type State = { picks: { date: string; scientific_name: string }[] };
type Article = { lang: string; title: string; extract: string; fullurl: string };

const dayName = new Date(`${date}T12:00:00Z`).toLocaleDateString("nb-NO", {
  timeZone: TIME_ZONE,
  weekday: "long",
  day: "numeric",
  month: "long",
});

// The day's detections, and everything each station heard before that day.
const [daily, history, state] = await Promise.all([
  Promise.all(stations.map((s) => birdnet<Species[]>(s, `analytics/species/daily?date=${date}`))),
  Promise.all(
    stations.map((s) => birdnet<Species[]>(s, `analytics/species/summary?start_date=2000-01-01&end_date=${shiftDay(date, -1)}`)),
  ),
  loadState<State>(STATE_KEY),
]);

// One entry per species, with the stations that heard it. Counts aren't summed: both frames may hear the same bird.
const heard = new Map<string, Heard>();
daily.forEach((list, i) => {
  for (const s of list) {
    const entry = heard.get(s.scientific_name) ?? {
      scientific: s.scientific_name,
      common: s.common_name,
      max: 0,
      stations: [],
      counts: {},
    };
    entry.max = Math.max(entry.max, s.count);
    entry.stations.push(stations[i].label);
    entry.counts[stations[i].label] = s.count;
    heard.set(s.scientific_name, entry);
  }
});
const species = [...heard.values()].sort((a, b) => b.max - a.max);
species.forEach((s) => s.stations.sort());

// A newcomer was never heard on any station before the day. BirdNET-Go's own is_new_species is per station, so a bird
// one frame has heard before isn't new when the other frame hears it for the first time.
const known = new Set(history.flat().map((s) => s.scientific_name));
const newcomers = species.filter((s) => !known.has(s.scientific));

// Bird of the day: a newcomer, or else a species from the day that wasn't picked in the 14 days up to it. The day
// itself counts, so running the same day again picks another bird.
const picks = state?.picks ?? [];
const recent = new Set(
  picks.filter((p) => p.date <= date && p.date >= shiftDay(date, -14)).map((p) => p.scientific_name),
);
const fresh = species.filter((s) => !recent.has(s.scientific));
const pool = newcomers.length ? newcomers.slice(0, 1) : fresh.length ? fresh : species;
const pick = pool.length ? pool[Math.floor(Math.random() * pool.length)] : undefined;

// The article by scientific name, Norwegian first. Wikipedia asks for a User-Agent that identifies the client.
async function wikipedia(lang: string, title: string): Promise<Article | null> {
  const url =
    `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1` +
    `&prop=extracts%7Cinfo&inprop=url&explaintext=1&exsectionformat=plain&titles=${encodeURIComponent(title)}`;
  const res = await fetchJson<{ query: { pages: (Article & { missing?: boolean })[] } }>(`Wikipedia ${lang}`, url, {
    headers: { "User-Agent": USER_AGENT },
  });
  const page = res.query.pages[0];
  return page && !page.missing && page.extract ? { ...page, lang } : null;
}

async function article(scientific: string): Promise<Article | null> {
  const norwegian = await wikipedia("no", scientific);
  if (norwegian && norwegian.extract.length >= MIN_ARTICLE) return norwegian;
  return (await wikipedia("en", scientific)) ?? norwegian;
}

const SYSTEM = `You pick one interesting fact about a bird from its Wikipedia article, for a short daily post about the birds heard at home.
Use only the article text you are given. Never add anything from your own knowledge, and don't guess about behaviour.
Prefer something memorable, like a habit, a record, its voice or a link to people, over its classification or range.
Answer with JSON. fact is one or two short sentences in Norwegian bokmål, at most 280 characters, calling the bird by the Norwegian name you are given.`;

const source = pick ? await article(pick.scientific) : null;
const fact =
  pick && source
    ? (
        await chat<{ fact: string }>(
          SYSTEM,
          `Bird: ${pick.common} (${pick.scientific}).\n\nWikipedia article (${source.lang}), "${source.title}":\n${source.extract.slice(0, 6000)}`,
          { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] },
        )
      ).fact
    : null;
console.log(JSON.stringify({ date, species: species.length, newcomers: newcomers.map((s) => s.common), pick, source: source?.fullurl, fact }, null, 2));

const named = (s: Heard) => `${s.common} (${s.stations.join(", ")})`;
const labels = stations.map((s) => s.label);
// One row per species with its count on each station, "-" where a station didn't hear it.
const countRows = species.map((s) => [s.common, ...labels.map((l) => s.counts[l] ?? "-")]);

// The same table as monospace text for Discord, which has no tables: a code block with the counts right-aligned.
function textTable(rows: (string | number)[][]): string {
  const widths = labels.map((l, i) => Math.max(l.length, ...rows.map((r) => String(r[i + 1]).length)));
  const nameWidth = Math.max(...rows.map((r) => String(r[0]).length));
  const line = (name: string, cells: (string | number)[]) =>
    [name.padEnd(nameWidth), ...cells.map((c, i) => String(c).padStart(widths[i]))].join("  ");
  return ["```", line("", labels), ...rows.map((r) => line(String(r[0]), r.slice(1))), "```"].join("\n");
}
const collage = Bun.file(env("COLLAGE_FILE"));
if (!(await collage.exists())) throw new Error(`no image at ${env("COLLAGE_FILE")}`);

// The tile: the species count, the first two newcomers and a count of the rest, and the bird of the day's name.
const firstNew = newcomers.slice(0, 2).map((s) => s.common).join(", ");
await publishTile("birds", {
  species: String(species.length),
  new: newcomers.length ? `🆕 ${firstNew}${newcomers.length > 2 ? ` +${newcomers.length - 2}` : ""}` : "none",
  bird: pick?.common ?? "none",
});

// Discord: one message in Norwegian, with the image of the day's birds. The link is in <> so Discord doesn't add a preview card.
const lines = [
  `🐦 **Fuglene i går** · ${dayName}`,
  species.length ? `${species.length} arter hørt.` : "Ingen fugler hørt.",
  ...(newcomers.length ? ["", `🆕 **Nye arter:** ${newcomers.map(named).join(", ")}`] : []),
  ...(species.length ? ["", "**Hørt i går**", textTable(countRows)] : []),
  ...(pick ? ["", `⭐ **Dagens fugl: ${pick.common}** *(${pick.scientific})*`] : []),
  ...(fact && source ? [fact, `<${source.fullurl}>`] : []),
];
if (collage.size > MAX_IMAGE) console.log(`the image is ${collage.size} bytes, over Discord's limit, so it's left out`);
await postDiscord(lines.join("\n"), collage.size > MAX_IMAGE ? undefined : { name: "fugler.png", data: collage });

if (pick) await saveState(STATE_KEY, { picks: [...picks, { date, scientific_name: pick.scientific }].slice(-30) });
