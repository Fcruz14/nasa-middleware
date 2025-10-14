import fetch from "node-fetch";
import mcache from "memory-cache";

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
const WAQI_TOKEN = "6db8353e8e1a074e990dc07c3c98dc1e3394a5c8";

function getAQIInfo(aqi) {
  if (aqi <= 50) return { level: "Good", color: "green" };
  if (aqi <= 100) return { level: "Moderate", color: "yellow" };
  if (aqi <= 150) return { level: "Unhealthy for Sensitive Groups", color: "orange" };
  if (aqi <= 200) return { level: "Unhealthy", color: "red" };
  if (aqi <= 300) return { level: "Very Unhealthy", color: "purple" };
  return { level: "Hazardous", color: "maroon" };
}

async function fetchAirQuality(lat, lon) {
  const cacheKey = `__waqi__${lat}_${lon}`;
  const cached = mcache.get(cacheKey);
  if (cached) return cached;

  const url = `https://api.waqi.info/feed/geo:${lat};${lon}/?token=${WAQI_TOKEN}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`WAQI ${response.status} ${response.statusText}`);

  const json = await response.json();
  if (json.status !== "ok") throw new Error("No se encontraron datos WAQI");

  const d = json.data;
  const { level, color } = getAQIInfo(d.aqi);

  const simplified = {
    code: 200,
    description: "Datos de calidad del aire",
    data: {
      coordinates: d.city.geo,
      location: d.city.name,
      aqi: d.aqi,
      level,
      color,
      dominant: d.dominentpol,
      mainPollutants: {
        pm25: d.iaqi?.pm25?.v ?? null,
        pm10: d.iaqi?.pm10?.v ?? null,
        co: d.iaqi?.co?.v ?? null,
        no2: d.iaqi?.no2?.v ?? null,
        so2: d.iaqi?.so2?.v ?? null,
        o3: d.iaqi?.o3?.v ?? null,
      },
      temp: d.iaqi?.t?.v ?? null,
      humidity: d.iaqi?.h?.v ?? null,
      pressure: d.iaqi?.p?.v ?? null,
      time: d.time?.iso ?? null,
      source: d.attributions?.map(a => a.name).join(", ")
    }
  };

  mcache.put(cacheKey, simplified, CACHE_TTL_MS);
  return simplified;
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const { lat, lon } = req.query;
  if (!lat || !lon)
    return res.status(400).json({ code: 400, description: "Faltan parámetros lat/lon" });

  try {
    const result = await fetchAirQuality(lat, lon);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ code: 500, description: "Error WAQI", data: err.message });
  }
}
