import { t } from "./i18n.js?v=20261008-3";

export const API_BASE = "https://api.first.global";
export const RESULTS_BASE = "https://results.first.global";

export async function fetchSeason(year, signal, includeDetails = false) {
  const url = new URL("/v1", API_BASE);
  url.searchParams.set("year", String(year));
  url.searchParams.set("excludeMatchDetails", String(!includeDetails));

  const response = await fetch(url, {
    signal,
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(t("apiHttp", { status: response.status }));
  }

  const data = await response.json();
  if (!data || !Array.isArray(data.rankings) || !Array.isArray(data.matches)) {
    throw new Error(t("apiInvalid"));
  }
  return data;
}
