// BirdNET-Go on the frames at home, for the bird digest and its proxy: the stations, the day, and the API.
//
// Env: BIRD_STATIONS, label=url pairs separated by commas, and optionally BIRD_DATE (yyyy-mm-dd), the day to cover
// instead of yesterday, e.g. to test the newcomer logic on a day with a known first detection.
import { env, fetchJson, TIME_ZONE } from "./common.ts";

const DAY = 24 * 3600 * 1000;

export type Station = { label: string; url: string };

export const stations: Station[] = env("BIRD_STATIONS")
  .split(",")
  .map((pair) => {
    const [label, url] = pair.split("=");
    return { label: label.trim(), url: url.trim() };
  });

// Dates are local calendar days. Noon UTC keeps the day arithmetic clear of the DST change.
export const shiftDay = (date: string, days: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);

export const birdDate =
  process.env.BIRD_DATE ?? new Date(Date.now() - DAY).toLocaleDateString("en-CA", { timeZone: TIME_ZONE });

// birdnet GETs PATH under /api/v2 on a station.
export function birdnet<T>(station: Station, path: string): Promise<T> {
  return fetchJson<T>(`BirdNET-Go ${station.label}`, `${station.url}/api/v2/${path}`);
}
