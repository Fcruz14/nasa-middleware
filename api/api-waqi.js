import fetch from "node-fetch";
import mcache from "memory-cache";

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
const WAQI_TOKEN = "6db8353e8e1a074e990dc07c3c98dc1e3394a5c8";

// Escala estándar AQI
function getAQIInfo(aqi) {
  if (aqi == null) return { level: "Sin datos", color: "gray" };
  if (aqi <= 50) return { level: "Bueno", color: "green" };
  if (aqi <= 100) return { level: "Moderado", color: "yellow" };
  if (aqi <= 150) return { level: "Dañina a grupos sensibles", color: "orange" };
  if (aqi <= 200) return { level: "Dañina", color: "red" };
  if (aqi <= 300) return { level: "Muy dañina", color: "purple" };
  return { level: "Peligrosa", color: "maroon" };
}

// helper para empaquetar valor + info
function mapWithInfo(value) {
  const info = getAQIInfo(value);
  return { value, ...info };
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
      aqi: {
        value: d.aqi,
        level,
        color
      },
      dominant: d.dominentpol,
      mainPollutants: {
        pm25: mapWithInfo(d.iaqi?.pm25?.v),
        pm10: mapWithInfo(d.iaqi?.pm10?.v),
        co: mapWithInfo(d.iaqi?.co?.v),
        no2: mapWithInfo(d.iaqi?.no2?.v),
        so2: mapWithInfo(d.iaqi?.so2?.v),
        o3: mapWithInfo(d.iaqi?.o3?.v),
      },
      environment: {
        temp: d.iaqi?.t?.v ?? null,
        humidity: d.iaqi?.h?.v ?? null,
        pressure: d.iaqi?.p?.v ?? null,
      },
      time: d.time?.iso ?? null,
      source: d.attributions?.map(a => a.name).join(", ") || "Desconocido"
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
