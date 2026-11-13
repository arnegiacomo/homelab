// Clients for the APIs the digests read: Ollama, Prometheus, GitHub and met.no.
import { env, fetchJson, TIME_ZONE, USER_AGENT } from "./common.ts";

// chat sends one prompt to the local model through Ollama's OpenAI-compatible API, and makes it answer with JSON
// that matches SCHEMA. Thinking is off: the facts are all in the prompt, and with it on a digest took 3-5 minutes.
// The context window is the server default, OLLAMA_CONTEXT_LENGTH, so the request doesn't make Ollama reload the model.
export async function chat<T>(system: string, user: string, schema: object): Promise<T> {
  const res = await fetchJson<{ choices: { message: { content: string } }[] }>(
    "Ollama",
    `${env("OLLAMA_URL")}/v1/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env("OLLAMA_MODEL"),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_schema", json_schema: { name: "digest", schema } },
        reasoning_effort: "none",
      }),
      signal: AbortSignal.timeout(600_000),
    },
  );
  return JSON.parse(res.choices[0].message.content) as T;
}

// chatWithContext is chat with a larger context window, for a prompt that doesn't fit the default. It uses Ollama's
// own API, since the OpenAI-compatible one can't set the window. Ollama reloads the model for it, and again for the
// next call at the default size. Ollama cuts a prompt that's too long without saying so, so this throws when the
// prompt and the answer filled the window.
export async function chatWithContext<T>(system: string, user: string, schema: object, contextLength: number): Promise<T> {
  type Answer = { message: { content: string }; prompt_eval_count: number; eval_count: number };
  const res = await fetchJson<Answer>("Ollama", `${env("OLLAMA_URL")}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env("OLLAMA_MODEL"),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      format: schema,
      think: false,
      stream: false,
      options: { num_ctx: contextLength },
    }),
    signal: AbortSignal.timeout(3_600_000),
  });
  console.log(`Ollama: ${res.prompt_eval_count} prompt tokens, ${res.eval_count} answer tokens, window ${contextLength}`);
  if (res.prompt_eval_count + res.eval_count >= contextLength) throw new Error("Ollama: the prompt doesn't fit the context window");
  return JSON.parse(res.message.content) as T;
}

export type Sample = { metric: Record<string, string>; value: [number, string] };

export async function query(promql: string): Promise<Sample[]> {
  const url = `${env("PROMETHEUS_URL")}/api/v1/query?query=${encodeURIComponent(promql)}`;
  const res = await fetchJson<{ data: { result: Sample[] } }>(`Prometheus ${promql}`, url);
  return res.data.result;
}

export function github<T>(path: string): Promise<T> {
  return fetchJson<T>(`GitHub ${path}`, `https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${env("GITHUB_TOKEN")}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
    },
  });
}

// graphql runs a GitHub GraphQL query, for what REST doesn't have (Discussions).
export async function graphql<T>(query: string, variables: Record<string, string | null>): Promise<T> {
  const res = await fetchJson<{ data?: T; errors?: { message: string }[] }>("GitHub GraphQL", "https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${env("GITHUB_TOKEN")}`, "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.data || res.errors) throw new Error(`GitHub GraphQL: ${JSON.stringify(res.errors)}`);
  return res.data;
}

type Forecast = {
  properties: {
    timeseries: {
      time: string;
      data: {
        instant: { details: { air_temperature: number; wind_speed: number } };
        next_1_hours?: { summary: { symbol_code: string }; details: { precipitation_amount: number } };
      };
    }[];
  };
};

// sky is the emoji for each of 08, 12, 16 and 20 that's still ahead, with repeats dropped. Rain is in mm, wind in m/s.
export type Weather = { sky: string[]; min: number; max: number; rain: number; wind: number };

// weather summarizes today's met.no Locationforecast, 06:00 to 23:00 local time. met.no requires a User-Agent that
// identifies the client, and at most 4 decimals in the coordinates.
export async function weather(lat: string, lon: string): Promise<Weather> {
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`;
  const res = await fetchJson<Forecast>("met.no", url, { headers: { "User-Agent": USER_AGENT } });
  const today = localDate(new Date());
  const hours = res.properties.timeseries.filter((t) => {
    const time = new Date(t.time);
    const hour = localHour(time);
    return localDate(time) === today && hour >= 6 && hour <= 23 && t.data.next_1_hours;
  });
  if (hours.length === 0) throw new Error("met.no: no forecast for today");
  const temps = hours.map((t) => t.data.instant.details.air_temperature);
  return {
    sky: hours
      .filter((t) => [8, 12, 16, 20].includes(localHour(new Date(t.time))))
      .map((t) => skyEmoji(t.data.next_1_hours?.summary.symbol_code ?? ""))
      .filter((emoji, i, all) => emoji !== all[i - 1]),
    min: Math.round(Math.min(...temps)),
    max: Math.round(Math.max(...temps)),
    rain: hours.reduce((sum, t) => sum + (t.data.next_1_hours?.details.precipitation_amount ?? 0), 0),
    wind: Math.round(Math.max(...hours.map((t) => t.data.instant.details.wind_speed))),
  };
}

export function weatherLine(w: Weather): string {
  return [
    w.sky.join(" → "),
    `${w.min}–${w.max} °C`,
    w.rain >= 0.1 ? `💧 ${w.rain.toFixed(1)} mm` : "no rain",
    `💨 ${w.wind} m/s`,
  ].join(" · ");
}

// skyEmoji maps a met.no symbol code, e.g. lightrainshowers_day, to an emoji. Order matters: "rainshowers"
// before "rain", "partlycloudy" before "cloudy".
function skyEmoji(code: string): string {
  const emojis: [string, string][] = [
    ["thunder", "⛈️"],
    ["snow", "🌨️"],
    ["sleet", "🌨️"],
    ["rainshowers", "🌦️"],
    ["rain", "🌧️"],
    ["fog", "🌫️"],
    ["clearsky", "☀️"],
    ["fair", "🌤️"],
    ["partlycloudy", "⛅"],
    ["cloudy", "☁️"],
  ];
  return emojis.find(([name]) => code.includes(name))?.[1] ?? "🌡️";
}

function localDate(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: TIME_ZONE });
}

function localHour(date: Date): number {
  return Number(date.toLocaleString("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", hourCycle: "h23" }));
}
