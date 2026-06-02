function getRequestBody(req) {
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      throw new Error("Invalid JSON body");
    }
  }

  return req.body || {};
}

function stripJsonFences(text) {
  return String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractAnthropicText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }

  if (Array.isArray(data?.content)) {
    return data.content
      .map((block) => (typeof block?.text === "string" ? block.text : ""))
      .join("")
      .trim();
  }

  return "";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = getRequestBody(req);
    const {
      assetType,
      submarket,
      price,
      sqft,
      yearBuilt,
      capRate,
      noi,
      holdPeriod,
      occupancy,
      tenantCredit,
      walt,
      irr,
      dscr,
    } = body;

    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not configured");
    }

    const prompt = `You are a senior commercial real estate research analyst. Provide market intelligence for the following deal.

DEAL INPUTS:
- Asset type: ${assetType}
- Location/submarket: ${submarket}
- Asking price: ${price}
- Square footage: ${sqft} SF
- Year built: ${yearBuilt}
- Advertised cap rate: ${capRate}%
- Occupancy: ${occupancy}%
- Tenant credit: ${tenantCredit}
- WALT: ${walt} years
- Holding period: ${holdPeriod} years
- Model IRR: ${irr}
- Model DSCR: ${dscr}

Respond ONLY with a valid JSON object — no markdown, no preamble, no explanation outside the JSON.
{
  \"capRateRange\": \"e.g. 5.5%–6.5%\",
  \"capRateTrend\": \"compressing | stable | expanding\",
  \"capRateTrendNote\": \"one sentence\",
  \"supplyDemandSignal\": \"strong demand | balanced | oversupplied\",
  \"supplyDemandNote\": \"one sentence\",
  \"rentGrowthOutlook\": \"e.g. +3–4% annually\",
  \"rentGrowthNote\": \"one sentence\",
  \"flags\": [
    { \"sentiment\": \"bullish | neutral | bearish\", \"text\": \"concise flag\" },
    { \"sentiment\": \"bullish | neutral | bearish\", \"text\": \"concise flag\" },
    { \"sentiment\": \"bullish | neutral | bearish\", \"text\": \"concise flag\" }
  ],
  \"thesis\": \"2–3 sentence investment thesis specific to this deal.\"
}`;

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1000,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }],
          },
        ],
      }),
    });

    if (!anthropicRes.ok) {
      const errorText = await anthropicRes.text().catch(() => "");
      throw new Error(
        errorText
          ? `Anthropic API error ${anthropicRes.status}: ${errorText}`
          : `Anthropic API error ${anthropicRes.status}`
      );
    }

    const data = await anthropicRes.json();
    const rawText = extractAnthropicText(data);

    if (!rawText) {
      throw new Error("Anthropic returned no text content");
    }

    const parsed = JSON.parse(stripJsonFences(rawText));
    return res.status(200).json(parsed);
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Unexpected error" });
  }
}
