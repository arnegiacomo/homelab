// A stand-in BirdNET-Go that answers with both frames at once, for the bird digest's image. fugleramme reads it as one
// station and renders its collage once (--preview) in the bird-digest Job, where this runs as a sidecar on :8090.
//
// It only serves the digest's day (BIRD_DATE, else yesterday), whatever window fugleramme asks for, so the image shows
// the same birds as the digest's list. fugleramme folds summary rows with the same scientific name into one, adding
// the counts, so both frames' summaries are simply concatenated. Names, locales and the species list come from the
// first station.
import { birdDate, birdnet, stations } from "./birdnet.ts";

type Detection = { date: string; timestamp: string };

async function summary(): Promise<unknown[]> {
  const rows = await Promise.all(
    stations.map((s) => birdnet<unknown[]>(s, `analytics/species/summary?start_date=${birdDate}&end_date=${birdDate}`)),
  );
  return rows.flat();
}

// The newest detections from the day, both frames, newest first. A detection's date is the station's local day.
async function recent(limit: number): Promise<Detection[]> {
  const rows = await Promise.all(stations.map((s) => birdnet<Detection[]>(s, "detections/recent?limit=1000")));
  return rows
    .flat()
    .filter((d) => d.date === birdDate)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, limit);
}

Bun.serve({
  port: 8090,
  async fetch(req) {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/api/v2/ping":
      case "/api/v2/health":
        return Response.json({ status: "ok" });
      case "/api/v2/analytics/species/summary":
        return Response.json(await summary());
      case "/api/v2/detections/recent":
        return Response.json(await recent(Number(url.searchParams.get("limit") ?? 10)));
    }
    // Passed through byte for byte: the name dictionaries come gzipped, and unpacked under their gzip headers they
    // read as garbage.
    const res = await fetch(`${stations[0].url}${url.pathname}${url.search}`, {
      method: req.method,
      headers: req.headers,
      decompress: false,
    });
    return new Response(res.body, { status: res.status, headers: res.headers });
  },
});
console.log(`serving ${stations.map((s) => s.label).join(" + ")} for ${birdDate} on :8090`);
// The kubelet stops the sidecar with SIGTERM once the digest is done. That's the normal end, not an error.
process.on("SIGTERM", () => process.exit(0));
