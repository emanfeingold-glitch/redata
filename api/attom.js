function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function subtractMonths(date, months) {
  const result = new Date(date);
  const originalDay = result.getUTCDate();

  result.setUTCMonth(result.getUTCMonth() - months);

  if (result.getUTCDate() !== originalDay) {
    result.setUTCDate(0);
  }

  return result;
}

function computeMedian(values) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[midpoint];
  }

  return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toNullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function parseJsonSafely(responseResult) {
  if (responseResult.status !== "fulfilled" || !responseResult.value?.ok) {
    return null;
  }

  try {
    return await responseResult.value.json();
  } catch {
    return null;
  }
}

function processComps(properties) {
  const propertyList = Array.isArray(properties) ? properties : [];
  const commercialProperties = propertyList.filter((p) => {
    const proptype = (p?.summary?.proptype ?? "").toLowerCase();
    const propLandUse = (p?.summary?.propLandUse ?? "").toLowerCase();

    // Block single-family, vacant land, condos, and other non-investment residential
    const blocked = [
      "single family", "sfr", "vacant land", "condominium",
      "townhouse", "mobile home", "timeshare"
    ];
    if (blocked.some((term) => proptype.includes(term) || propLandUse.includes(term))) return false;

    // Allow anything with a building size (filters out true vacant land)
    const hasSqft = (
      p?.building?.size?.universalsize ||
      p?.building?.size?.grosssize ||
      p?.building?.size?.livingsize
    ) > 0;

    // Allow all CRE asset types including multifamily, medical, and data center
    const isCommercial = [
      "multi", "apartment", "commercial", "industrial",
      "office", "retail", "mixed", "medical", "warehouse",
      "storage", "healthcare", "clinic", "outpatient",
      "special purpose", "technology", "flex", "data",
      "laboratory", "net lease"
    ].some((term) => proptype.includes(term) || propLandUse.includes(term));

    return isCommercial || hasSqft;
  });

  return commercialProperties
    .map((property) => {
      const saleAmt = toNumber(property?.sale?.amount?.saleamt);
      const sqft = toNumber(
        property?.building?.size?.universalsize ||
        property?.building?.size?.grosssize ||
        property?.building?.size?.livingsize ||
        0
      );

      if (saleAmt <= 0 || sqft <= 0) {
        return null;
      }

      return {
        address: property?.address?.line1 ?? "",
        saleDate: property?.sale?.salesearchdate ?? "",
        saleAmt,
        sqft,
        pricePerSqft: saleAmt / sqft,
        propType: property?.summary?.proptype ?? "",
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.saleDate) - new Date(a.saleDate))
    .slice(0, 10);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { address1, address2 } = req.query;

  if (!address1 || !address2) {
    return res.status(400).json({ error: "address1 and address2 are required" });
  }

  const apiKey = process.env.ATTOM_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: "API key not configured" });
  }

  const today = new Date();
  const endDate = formatDate(today);
  const startDate = formatDate(subtractMonths(today, 18));

  const radii = [1, 3, 5];
  let lastData = null;
  let usedRadius = 1;

  for (const radius of radii) {
    const attomUrl = new URL("https://api.gateway.attomdata.com/propertyapi/v1.0.0/sale/snapshot");
    attomUrl.searchParams.set("address1", address1);
    attomUrl.searchParams.set("address2", address2);
    attomUrl.searchParams.set("radius", radius);
    attomUrl.searchParams.set("pagesize", "50");
    attomUrl.searchParams.set("startsalesearchdate", startDate);
    attomUrl.searchParams.set("endsalesearchdate", endDate);

    const attomRes = await fetch(attomUrl.toString(), {
      headers: {
        apikey: apiKey,
        Accept: "application/json",
      },
    });

    if (!attomRes.ok) {
      return res.status(502).json({
        error: "ATTOM API error",
        status: attomRes.status,
      });
    }

    const attomData = await attomRes.json();
    const properties = attomData?.property ?? [];
    const validComps = processComps(properties);

    lastData = { comps: validComps, radius };
    usedRadius = radius;

    if (validComps.length > 0) break;
  }

  const [avmRes, taxRes] = await Promise.allSettled([
    fetch(`https://api.gateway.attomdata.com/propertyapi/v1.0.0/avm/detail?address1=${encodeURIComponent(address1)}&address2=${encodeURIComponent(address2)}`, {
      headers: { apikey: process.env.ATTOM_API_KEY, accept: "application/json" }
    }),
    fetch(`https://api.gateway.attomdata.com/propertyapi/v1.0.0/property/taxes?address1=${encodeURIComponent(address1)}&address2=${encodeURIComponent(address2)}`, {
      headers: { apikey: process.env.ATTOM_API_KEY, accept: "application/json" }
    })
  ]);

  const avmData = await parseJsonSafely(avmRes);
  const taxData = await parseJsonSafely(taxRes);
  const avmAmount = avmData?.property?.[0]?.avm?.amount;
  const taxAssessment = taxData?.property?.[0]?.assessment?.tax;
  const avmValue = toNullableNumber(avmAmount?.value);
  const avmHigh = toNullableNumber(avmAmount?.high);
  const avmLow = toNullableNumber(avmAmount?.low);
  const annualTaxes = toNullableNumber(taxAssessment?.taxamt);

  if (!lastData || lastData.comps.length === 0) {
    return res.status(200).json({
      comps: [],
      medianPricePerSqft: null,
      compCount: 0,
      radiusMiles: usedRadius,
      avmValue,
      avmHigh,
      avmLow,
      annualTaxes,
    });
  }

  return res.status(200).json({
    comps: lastData.comps,
    medianPricePerSqft: computeMedian(lastData.comps.map((comp) => comp.pricePerSqft)),
    compCount: lastData.comps.length,
    radiusMiles: usedRadius,
    avmValue,
    avmHigh,
    avmLow,
    annualTaxes,
  });
}
