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
    const rawText = typeof body.rawText === "string" ? body.rawText.trim() : "";

    if (!rawText) {
      throw new Error("rawText is required");
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not configured");
    }

    const systemPrompt = `You are a commercial real estate data extraction and analysis engine.
You receive raw text copied from a LoopNet property listing page.
Your job is to do two things in one pass:
  1. Extract structured deal data into "fields"
  2. Generate six market intelligence modules into "intel"

Respond with ONLY a valid JSON object. No preamble, no markdown fences,
no explanation. Fields you cannot find or confidently infer must be null.`;

    const userPrompt = `Analyze this LoopNet listing and return a single JSON object with exactly
two top-level keys: "fields" and "intel".

LISTING TEXT:
---
${rawText}
---

=== SCHEMA ===

{
  "fields": {

    // ── Core form fields ─────────────────────────────────────────
    "price":              number | null,   // asking price in dollars, no commas
    "sqft":               number | null,   // total rentable SF
    "yearBuilt":          number | null,   // 4-digit year
    "yearRenovated":      number | null,   // 4-digit year if renovated, else null
    "advertisedNoi":      number | null,   // annual NOI in dollars
    "advertisedCapRate":  number | null,   // cap rate as decimal percent e.g. 6.5
    "occupancyPct":       number | null,   // 0–100
    "addressLine1":       string | null,   // street address only
    "addressLine2":       string | null,   // "City, ST XXXXX" only
    "assetType":          string | null,   // exactly one of: Industrial | Multifamily |
                                           //   Office | Retail | Medical Office |
                                           //   Self-Storage | Data Center
    "holdingPeriod":      null,            // always null — user sets this

    // ── Advanced panel fields ─────────────────────────────────────
    "leaseType":          string | null,   // NNN | Gross | Modified Gross | Double Net
    "tenantNames":        string[] | null, // every named tenant found anywhere in text
    "tenantCredit":       string | null,   // institutional | regional | speculative
                                           // — infer from tenant names + description
    "walt":               number | null,   // weighted avg lease term in years
                                           // — extract or calculate from expiry dates
    "numTenants":         number | null,
    "leaseExpiryPct":     number | null,   // % of leases expiring within 24 months
    "stories":            number | null,
    "lotSizeSF":          number | null,
    "parkingRatio":       number | null,   // spaces per 1,000 SF
    "units":              number | null,   // multifamily only
    "noiBasis":           string | null,   // "inplace" | "proforma"
    "brokerRemarks":      string | null,   // full description/remarks, max 500 chars

    // ── Confidence map ────────────────────────────────────────────
    // For each field that was INFERRED (not explicitly stated in the listing),
    // set its value to "inferred". Explicitly stated fields: "stated".
    // Only include fields where the distinction matters for the user to know.
    "confidence": {
      "tenantCredit":  "stated" | "inferred",
      "walt":          "stated" | "inferred",
      "assetType":     "stated" | "inferred",
      "noiBasis":      "stated" | "inferred"
    }
  },

  "intel": {

    // ── Module 1: Tenant Credit Intelligence ─────────────────────
    // Only populate if named tenants are present. Null if no named tenants.
    "tenantIntel": {
      "summary":            string | null, // 2–3 sentence credit + sector profile
      "creditRating":       string | null, // e.g. "BBB- (S&P)" or "Not rated — regional"
      "creditTier":         string | null, // "Investment Grade" | "Sub-IG" | "Unrated"
      "sectorSignal":       string | null, // e.g. "Discount retail: counter-cyclical demand"
      "concentrationRisk":  string | null, // single-tenant vs multi-tenant risk statement
      "capRateImplication": string | null  // how this tenant's credit affects market cap rate
                                           // vs. generic asset type — e.g. "IG NNN anchor
                                           // typically compresses cap 50–100bps vs. local tenant"
    } | null,

    // ── Module 2: Location & Neighborhood Quality ─────────────────
    "locationIntel": {
      "summary":           string | null, // 2–3 sentence submarket quality assessment
      "infillSignal":      string | null, // "Infill" | "Suburban" | "Exurban" + 1-sentence rationale
      "logisticsAccess":   string | null, // for Industrial/Retail: port, airport, highway access;
                                          // null for Office/Multifamily unless relevant
      "climateRiskFlag":   string | null, // flood zone, hurricane, wildfire — especially for FL, TX,
                                          // CA assets; null if low-risk or unknown location
      "neighborhoodTrend": string | null, // "Gentrifying" | "Stable" | "Declining" + rationale
      "laborMarket":       string | null  // for Industrial: warehouse/logistics wage trends in MSA;
                                          // null for other asset types
    } | null,

    // ── Module 3: Lease Expiration Risk & WALT Stress Test ────────
    "leaseRiskIntel": {
      "summary":           string | null, // 2–3 sentence interpretation of WALT + lease type
                                          // + occupancy together as a combined risk statement
      "rolloverExposure":  string | null, // "Low" | "Moderate" | "High" + 1 sentence
      "markToMarketAngle": string | null, // Is short WALT an opportunity (below-market rents,
                                          // re-lease upside) or a risk (credit deterioration)?
      "retenantingCost":   string | null, // estimated TI, LC, and downtime assumptions
                                          // for this asset type + submarket if rollover occurs
      "absorptionOutlook": string | null  // can this submarket absorb re-leasing at flat
                                          // or higher rents given current vacancy?
    } | null,

    // ── Module 4: Submarket Supply Pipeline ──────────────────────
    "supplyIntel": {
      "summary":           string | null, // 2–3 sentence pipeline + absorption synthesis
      "supplySignal":      string | null, // "Tight" | "Balanced" | "Oversupplied"
      "constructionTrend": string | null, // Is spec construction rising, falling, or halted?
      "absorptionTrend":   string | null, // Is the market absorbing new supply or seeing rising vacancy?
      "rentGrowthOutlook": string | null, // e.g. "+2–4% / yr" or "Flat to negative"
      "rentGrowthNote":    string | null, // 1-sentence explanation
      "demandDrivers":     string | null  // key demand tailwinds or headwinds specific to
                                          // this asset type + MSA, e.g. e-commerce for
                                          // industrial, hybrid work for office
    } | null,

    // ── Module 5: Pricing Sanity Check ───────────────────────────
    "pricingIntel": {
      "summary":          string | null, // 2–3 sentence verdict on whether pricing is
                                         // cheap, fair, or expensive vs. recent trades
      "pricingVerdict":   string | null, // "Cheap" | "Fair" | "Aggressive" | "Distressed"
      "replacementCost":  string | null, // is asking price above or below estimated
                                         // replacement cost for this asset type + vintage?
      "sellerMotivation": string | null, // any signals of seller motivation, loan maturity,
                                         // 1031 pressure, estate sale, etc. — from broker
                                         // remarks or pricing relative to market
      "capRateRange":     string | null, // market cap rate range for this asset type
                                         // and submarket e.g. "5.5% – 6.5%"
      "capRateTrend":     string | null, // "compressing" | "stable" | "expanding"
      "capRateTrendNote": string | null  // 1-sentence explanation
    } | null,

    // ── Module 6: Debt Market Fit ─────────────────────────────────
    "debtIntel": {
      "summary":           string | null, // 2–3 sentence financing environment assessment
      "agencyEligible":    boolean | null, // true only for multifamily (Fannie/Freddie/HUD)
      "recommendedLender": string | null,  // "CMBS" | "Life Company" | "Bank/Credit Union" |
                                           // "Agency" | "Debt Fund" — best fit for this
                                           // asset type, size, and cap rate
      "lenderRationale":   string | null,  // 1-sentence explanation of why that lender type
      "ioLikelihood":      string | null,  // "Common" | "Possible" | "Unlikely" — interest-only
                                           // period availability for this deal profile
      "prepaymentRisk":    string | null,  // "Defeasance" | "Yield Maintenance" | "Step-down" |
                                           // "Open" — typical structure and what it means
                                           // for a 5-yr hold
      "rateLockNote":      string | null   // any rate lock timing risk given current rate environment
    } | null,

    // ── Synthesized flags (3–5 total across all modules) ─────────
    // Each flag is a single deal-specific signal. Do not repeat points
    // already covered verbatim in the module summaries above. These should
    // be the most actionable, memorable takeaways.
    "flags": [
      { "sentiment": "bullish" | "neutral" | "bearish", "text": string }
    ],

    // ── Broker remarks flag ───────────────────────────────────────
    // If broker remarks contain a motivated seller signal, urgency, distress,
    // unusual terms, or 1031 pressure — extract and surface it here as a
    // plain string. null if nothing notable.
    "brokerRemarkFlag": string | null,

    // ── Investment thesis ─────────────────────────────────────────
    // 3–4 sentences synthesizing asset type, submarket, tenant credit,
    // lease structure, supply/demand, and pricing into a single coherent
    // investment thesis. Write it as a professional analyst would.
    "thesis": string
  }
}

Return ONLY the JSON object.`;

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1800,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userPrompt }],
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

    // Check for max_tokens truncation before attempting parse
    if (data?.stop_reason === 'max_tokens') {
      throw new Error(
        'Listing too long for AI parser — response was cut off. Try trimming the pasted text to the key facts section only.'
      );
    }

    const rawResponseText = extractAnthropicText(data);

    if (!rawResponseText) {
      throw new Error("Anthropic returned no text content");
    }

    const parsed = JSON.parse(stripJsonFences(rawResponseText));
    return res.status(200).json(parsed);
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Unexpected error" });
  }
}
