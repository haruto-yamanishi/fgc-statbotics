export const API_BASE = "https://api.first.global";
export const RESULTS_BASE = "https://results.first.global";

export async function fetchSeason(year, signal) {
  const url = new URL("/v1", API_BASE);
  url.searchParams.set("year", String(year));
  url.searchParams.set("excludeMatchDetails", "true");

  const response = await fetch(url, {
    signal,
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`FIRST Global API returned ${response.status}`);
  }

  const data = await response.json();
  if (!data || !Array.isArray(data.rankings) || !Array.isArray(data.matches)) {
    throw new Error("FIRST Global API returned an unexpected payload");
  }
  return data;
}
