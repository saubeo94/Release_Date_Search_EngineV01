// Serverless proxy for the Zenith "ONEAPI Updated Game List" Airtable.
// Keeps AIRTABLE_TOKEN server-side (never shipped to the browser). Returns
// normalized rows the client feeds into the same pipeline as the CSV.

const BASE = "appcJn8Ck6R7RTccl";
const TABLE = "tblsnoI1fwUkVfg73";
const VIEW = "viwJ2rBmrvjE5YGoG";

let cache = { at: 0, rows: null };
const CACHE_MS = 10 * 60 * 1000;

export default async function handler(req, res) {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    res.status(404).json({ error: "AIRTABLE_TOKEN not configured" });
    return;
  }
  if (cache.rows && Date.now() - cache.at < CACHE_MS) {
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");
    res.status(200).json({ rows: cache.rows, source: "airtable(cached)" });
    return;
  }
  const rows = [];
  let offset;
  do {
    const params = new URLSearchParams({ view: VIEW, pageSize: "100" });
    if (offset) params.set("offset", offset);
    const r = await fetch(`https://api.airtable.com/v0/${BASE}/${TABLE}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      res.status(502).json({ error: `Airtable responded ${r.status}` });
      return;
    }
    const data = await r.json();
    for (const rec of data.records || []) {
      const f = rec.fields || {};
      const name = String(f["Game Name"] || "").trim();
      if (!name) continue;
      rows.push({
        name,
        vendor: String(f["Vendor"] || "").trim(),
        date: String(f["Released Date"] || "").trim(),
        status: String(f["Game Status"] || "").trim(),
      });
    }
    offset = data.offset;
  } while (offset);
  if (!rows.length) {
    res.status(502).json({ error: "Airtable returned no records" });
    return;
  }
  cache = { at: Date.now(), rows };
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");
  res.status(200).json({ rows, source: "airtable" });
}
