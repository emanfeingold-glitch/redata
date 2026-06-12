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

    const rawText = typeof body.rawText === "string" ? body.rawText.trim() : "";

    if (!rawText) {
      throw new Error("rawText is required");
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not configured");
    }

    const systemPrompt = `You are a commercial real estate data extraction engine.
You receive raw text copied from a LoopNet property listing page.
Your job is field extraction only.

Respond with ONLY a valid JSON object. No preamble, no markdown fences,
no explanation. Fields you cannot find or confidently infer must be null.`;

    const userPrompt = `Analyze this LoopNet listing and return a single JSON object with exactly
one top-level key: "fields".

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
        max_tokens: 3000,
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
    if (!parsed || !parsed.fields) {
      throw new Error("Invalid parser response");
    }
    return res.status(200).json(parsed);
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Unexpected error" });
  }
}
