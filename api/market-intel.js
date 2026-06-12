import { authorize } from "../lib/authorize.js";

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

    // Locked down: requires a valid score token bound to this caller + property.
    const authz = await authorize(req, { propertyId: body.propertyId });
    if (!authz.ok) return res.status(authz.status).json({ error: authz.code });

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
      rawScore,
    } = body;

    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not configured");
    }

        const prompt = `You are a senior commercial real estate research analyst. Analyze the following deal and return market intelligence across six structured modules.

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
- Current deal score: ${rawScore}/100

Score adjustment guidance:
- Return scoreAdjustment.delta as an integer between -15 and +15.
- Positive delta: market conditions meaningfully support the score (strong submarket, compressing cap rates, IG tenant, tight supply).
- Negative delta: market conditions undercut the score (aggressive pricing, expanding cap rates, oversupplied, high rollover risk).
- Zero: market context is broadly consistent with what the numbers already reflect.
- Keep scoreAdjustment.rationale to one concise sentence.

Respond ONLY with a valid JSON object — no markdown, no preamble, no explanation outside the JSON.

{
  "scoreAdjustment": {
    "delta": 0,
    "rationale": "one sentence"
  },
  "tenantIntel": {
    "summary": "2–3 sentence credit + sector profile, or null if no named tenants",
    "creditRating": "e.g. BBB- (S&P) or Not rated — regional",
    "creditTier": "Investment Grade | Sub-IG | Unrated",
    "sectorSignal": "e.g. Discount retail: counter-cyclical demand",
    "concentrationRisk": "single-tenant vs multi-tenant risk statement",
    "capRateImplication": "how tenant credit affects cap rate vs generic asset type"
  },
  "locationIntel": {
    "summary": "2–3 sentence submarket quality assessment",
    "infillSignal": "Infill | Suburban | Exurban + 1-sentence rationale",
    "logisticsAccess": "port, airport, highway access for Industrial/Retail or null",
    "climateRiskFlag": "flood zone, hurricane, wildfire risk or null if low-risk",
    "neighborhoodTrend": "Gentrifying | Stable | Declining + rationale",
    "laborMarket": "warehouse/logistics wage trends for Industrial or null"
  },
  "leaseRiskIntel": {
    "summary": "2–3 sentence interpretation of WALT + lease type + occupancy as combined risk",
    "rolloverExposure": "Low | Moderate | High + 1 sentence",
    "markToMarketAngle": "is short WALT an opportunity or a risk?",
    "retenantingCost": "estimated TI, LC, and downtime assumptions if rollover occurs",
    "absorptionOutlook": "can this submarket absorb re-leasing at flat or higher rents?"
  },
  "supplyIntel": {
    "summary": "2–3 sentence pipeline + absorption synthesis",
    "supplySignal": "Tight | Balanced | Oversupplied",
    "constructionTrend": "Is spec construction rising, falling, or halted?",
    "absorptionTrend": "Is the market absorbing new supply or seeing rising vacancy?",
    "rentGrowthOutlook": "e.g. +2–4% / yr or Flat to negative",
    "rentGrowthNote": "1-sentence explanation",
    "demandDrivers": "key demand tailwinds or headwinds for this asset type + MSA"
  },
  "pricingIntel": {
    "summary": "2–3 sentence verdict on whether pricing is cheap, fair, or expensive",
    "pricingVerdict": "Cheap | Fair | Aggressive | Distressed",
    "replacementCost": "is asking price above or below estimated replacement cost?",
    "sellerMotivation": "any signals of seller motivation, loan maturity, 1031 pressure or null",
    "capRateRange": "market cap rate range e.g. 5.5% – 6.5%",
    "capRateTrend": "compressing | stable | expanding",
    "capRateTrendNote": "1-sentence explanation"
  },
  "debtIntel": {
    "summary": "2–3 sentence financing environment assessment",
    "agencyEligible": true or false — true only for multifamily,
    "recommendedLender": "CMBS | Life Company | Bank/Credit Union | Agency | Debt Fund",
    "lenderRationale": "1-sentence explanation of why that lender type",
    "ioLikelihood": "Common | Possible | Unlikely",
    "prepaymentRisk": "Defeasance | Yield Maintenance | Step-down | Open",
    "rateLockNote": "rate lock timing risk given current rate environment"
  },
  "flags": [
    { "sentiment": "bullish | neutral | bearish", "text": "concise actionable flag" },
    { "sentiment": "bullish | neutral | bearish", "text": "concise actionable flag" },
    { "sentiment": "bullish | neutral | bearish", "text": "concise actionable flag" }
  ],
  "brokerRemarkFlag": "motivated seller signal or unusual terms if present, else null",
  "thesis": "3–4 sentence investment thesis synthesizing asset type, submarket, tenant credit, lease structure, supply/demand, and pricing."
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
        max_tokens: 6000,
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
