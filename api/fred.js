export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { seriesId } = req.query;

  if (!seriesId) {
    return res.status(400).json({ error: "seriesId is required" });
  }

  const apiKey = process.env.FRED_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: "FRED API key not configured" });
  }

  const fredUrl = new URL("https://api.stlouisfed.org/fred/series/observations");
  fredUrl.searchParams.set("series_id", seriesId);
  fredUrl.searchParams.set("api_key", apiKey);
  fredUrl.searchParams.set("sort_order", "desc");
  fredUrl.searchParams.set("limit", "1");
  fredUrl.searchParams.set("file_type", "json");

  const fredRes = await fetch(fredUrl.toString());

  if (!fredRes.ok) {
    return res.status(502).json({
      error: "FRED API error",
      status: fredRes.status,
    });
  }

  const data = await fredRes.json();
  const value = Number.parseFloat(data?.observations?.[0]?.value);

  if (!Number.isFinite(value)) {
    return res.status(502).json({ error: "FRED returned an invalid value" });
  }

  return res.status(200).json({ seriesId, value });
}
