import React, { useState, useEffect, useMemo, useRef } from "react";
import Papa from "papaparse";

/* ---------- helpers ---------- */

const normName = (s) =>
  (s || "")
    .toString()
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const normVendor = (s) =>
  (s || "").toString().toLowerCase().replace(/[^a-z0-9]/g, "");

// Parses every date format the sources use. Returns { d, precision } where
// precision is "full" | "month" | "year" — or { d: null }.
const parseAnyDate = (s) => {
  const t = (s || "").toString().trim();
  let m = t.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/); // 2026/7/30 · 2026-06-26
  if (m) return { d: new Date(+m[1], +m[2] - 1, +m[3]), precision: "full" };
  m = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/); // 30/7/2026 (day first)
  if (m) return { d: new Date(+m[3], +m[2] - 1, +m[1]), precision: "full" };
  m = t.match(/^(\d{4})[\/\-](\d{1,2})$/); // 2024/7
  if (m) return { d: new Date(+m[1], +m[2] - 1, 1), precision: "month" };
  m = t.match(/^(\d{4})$/); // 2019
  if (m) return { d: new Date(+m[1], 0, 1), precision: "year" };
  return { d: null, precision: null };
};

const today = () => {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate());
};

const daysFromToday = (date) =>
  Math.round((date.getTime() - today().getTime()) / 86400000);

// "10/7/2026" or "2026-07-10" -> "Fri, 10/07"; partial dates pass through
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const toSheetDate = (s) => {
  const { d, precision } = parseAnyDate(s);
  if (!d || precision !== "full") return (s || "").toString().trim();
  const pad = (n) => String(n).padStart(2, "0");
  return `${WEEKDAYS[d.getDay()]}, ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
};

// Normalize any parseable date to ISO for display: 26/6/2026 -> 2026-06-26,
// 2026/6/23 -> 2026-06-23; partial dates become 2024-07 / 2019; text passes through.
const fmtISO = (s) => {
  const { d, precision } = parseAnyDate(s);
  if (!d) return (s || "").toString().trim();
  const pad = (n) => String(n).padStart(2, "0");
  if (precision === "full") return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (precision === "month") return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  return String(d.getFullYear());
};

const classifyStatus = (s) => {
  const t = (s || "").toString();
  if (/removed|下架/i.test(t)) return "removed";
  if (/added|上架/i.test(t)) return "added";
  if (/up\s*coming|即将/i.test(t)) return "upcoming";
  if (/change/i.test(t)) return "change";
  return "other";
};

/* ---------- channels & brand families ---------- */

// The aggregator prefix in the sync sheet ("zen: Tada", "SS: Jili") names the
// channel a game is opened through — that channel's source decides its date.
const CHANNELS = { zen: "Zenith", zenith: "Zenith", ss: "SS", amb: "Amb" };

const channelOf = (providerRaw) => {
  if (!providerRaw || !providerRaw.includes(":")) return "";
  return CHANNELS[normVendor(providerRaw.split(":")[0])] || "";
};

// Brands that are one provider underneath (regional labels of the same games)
const BRAND_FAMILIES = [["jili", "tada"]];

const brandFamily = (v) => {
  for (const fam of BRAND_FAMILIES) {
    for (const member of fam) {
      if (member === v || (v.length >= 3 && (v.includes(member) || member.includes(v)))) return fam;
    }
  }
  return null;
};

const sameBrand = (a, b) => {
  if (!a || !b) return false;
  if (a === b || (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a)))) return true;
  const fa = brandFamily(a);
  return fa !== null && fa === brandFamily(b);
};

/* ---------- cell classification for pasted sheet rows ---------- */

const isUrl = (c) => /https?:\/\//i.test(c);
const isCheckbox = (c) => /^(true|false)$/i.test(c.trim());
// "Wed, 10/06" · "Thu, 11/06" · "10/06" · "10/6/2026"
const isDateCell = (c) => {
  const t = c.trim();
  return (
    /^[A-Za-z]{2,4},?\s*\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(t) ||
    /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(t)
  );
};
const isIgnorable = (c) =>
  !c.trim() || isCheckbox(c) || isDateCell(c) || isUrl(c) || /^\d+$/.test(c.trim());

const afterColon = (cell) => {
  const parts = cell.split(":");
  return parts[parts.length - 1].trim();
};

const hasProviderColon = (c) =>
  c.includes(":") &&
  !/^\d{1,2}:\d{2}(:\d{2})?$/.test(c.trim()) &&
  !isUrl(c) &&
  c.trim().length < 50;

// score how well a cell looks like the provider cell, using known vendors
function providerScore(cell, vendorKeys) {
  const candidate = normVendor(hasProviderColon(cell) ? afterColon(cell) : cell);
  if (!candidate || candidate.length < 2) return 0;
  let best = 0;
  for (const vk of vendorKeys) {
    if (candidate === vk) { best = Math.max(best, 3); }
    else if (vk.length >= 3 && candidate.length >= 3 && (candidate.includes(vk) || vk.includes(candidate))) {
      best = Math.max(best, 2);
    }
  }
  if (hasProviderColon(cell)) best = Math.max(best, 1) + 0.5; // colon is a strong hint
  return best;
}

function looksLikeHeader(cells) {
  const joined = cells.join(" ").toLowerCase();
  return (
    /game\s*name|aggre|provider|vendor|released?\s*date|bo\s*group|note/.test(joined) &&
    !cells.some(isDateCell)
  );
}

/* ---------- input parsing (vendor-aware) ---------- */

function parseInput(text, vendorKeys) {
  const lines = text.replace(/\r/g, "").split("\n");
  return lines.map((line, idx) => {
    const raw = line;
    const cells = line.split("\t").map((c) => c.trim());
    const nonEmpty = cells.filter(Boolean);
    if (!nonEmpty.length) return { idx, raw, game: "", provider: "", providerRaw: "", channel: "", empty: true };
    if (looksLikeHeader(nonEmpty)) return { idx, raw, game: "", provider: "", providerRaw: "", channel: "", header: true };

    // 1. find the provider cell: best vendor-match score, tie broken by colon presence
    let providerIdx = -1;
    let bestScore = 0.9; // require at least a weak signal
    cells.forEach((c, i) => {
      if (!c || isIgnorable(c)) return;
      const s = providerScore(c, vendorKeys);
      if (s > bestScore) { bestScore = s; providerIdx = i; }
    });

    // 2. game name = nearest usable cell to the LEFT of the provider cell
    let game = "", providerRaw = "", provider = "";
    if (providerIdx >= 0) {
      providerRaw = cells[providerIdx];
      provider = hasProviderColon(providerRaw) ? afterColon(providerRaw) : providerRaw;
      for (let i = providerIdx - 1; i >= 0; i--) {
        if (cells[i] && !isIgnorable(cells[i])) { game = cells[i]; break; }
      }
      if (!game) {
        for (let i = providerIdx + 1; i < cells.length; i++) {
          if (cells[i] && !isIgnorable(cells[i])) { game = cells[i]; break; }
        }
      }
    } else {
      // fallback: first two usable cells = game, provider
      const usable = cells.filter((c) => c && !isIgnorable(c));
      game = usable[0] || "";
      providerRaw = usable[1] || "";
      provider = providerRaw ? (hasProviderColon(providerRaw) ? afterColon(providerRaw) : providerRaw) : "";
    }
    return { idx, raw, game, provider, providerRaw, channel: channelOf(providerRaw) };
  });
}

/* ---------- Zenith matching (ONEAPI list) ---------- */

function buildIndex(rows) {
  const byName = new Map();
  rows.forEach((r, i) => {
    const key = normName(r.name);
    if (!key) return;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(i);
  });
  return byName;
}

function pickResult(rows, matchedIdx) {
  const matched = matchedIdx.map((i) => rows[i]);
  const withDates = matched
    .map((r) => ({ ...r, parsed: parseAnyDate(r.date).d, kind: classifyStatus(r.status) }))
    .filter((r) => r.parsed);

  if (!withDates.length) {
    return { state: "nodate", date: "", note: "No valid date in the Zenith list" };
  }

  const addedRows = withDates.filter((r) => r.kind === "added" || r.kind === "upcoming" || r.kind === "change");
  const removedRows = withDates.filter((r) => r.kind === "removed");

  const latest = (arr) => arr.reduce((a, b) => (b.parsed > a.parsed ? b : a));
  const primary = addedRows.length ? latest(addedRows) : latest(withDates);
  const lastRemoved = removedRows.length ? latest(removedRows) : null;

  let state, note = "";
  if (lastRemoved && addedRows.length && lastRemoved.parsed.getTime() === primary.parsed.getTime()) {
    state = "check";
    note = "Added and removed on the same date — verify manually";
  } else if (lastRemoved && (!addedRows.length || lastRemoved.parsed > primary.parsed)) {
    state = "removed";
    note = `Removed ${fmtISO(lastRemoved.date)}`;
  } else if (primary.parsed > today()) {
    state = "notyet";
    const d = daysFromToday(primary.parsed);
    note = d === 1 ? "releases tomorrow" : `releases in ${d} days`;
  } else {
    state = "released";
    const d = -daysFromToday(primary.parsed);
    note = d === 0 ? "released today" : `${d} days ago`;
  }
  if (primary.kind === "change") note = (note ? note + " · " : "") + "listed as code/name change";

  return { state, date: primary.date, matchedVendor: primary.vendor, note };
}

function lookupOne(input, rows, byName) {
  const nameKey = normName(input.game);
  if (!nameKey) return { state: "skipped", date: "", note: "Couldn't read a game name from this row" };

  const candidates = byName.get(nameKey) || [];
  if (!candidates.length) {
    return { state: "notfound", date: "", note: "not in the Zenith list" };
  }

  let pool = candidates;
  let vendorNote = "";
  if (input.provider) {
    const pv = normVendor(input.provider);
    const exact = candidates.filter((i) => normVendor(rows[i].vendor) === pv);
    // containment or same brand family (JILI ≡ TaDa) both count as a match
    const fuzzy = exact.length
      ? exact
      : candidates.filter((i) => sameBrand(normVendor(rows[i].vendor), pv));
    if (fuzzy.length) {
      pool = fuzzy;
    } else {
      const found = [...new Set(candidates.map((i) => rows[i].vendor))].join(", ");
      vendorNote = `Provider mismatch — Zenith has it under: ${found}`;
    }
  }

  const res = pickResult(rows, pool);
  if (vendorNote) {
    res.note = vendorNote + (res.note ? " · " + res.note : "");
    if (res.state === "released") res.state = "check";
  }
  return res;
}

/* ---------- Zenith CSV / live loading ---------- */

function parseDatabase(csvText) {
  const parsed = Papa.parse(csvText.trim(), { header: true, skipEmptyLines: true });
  if (!parsed.data.length) return { error: "No rows found in that CSV." };

  const headers = parsed.meta.fields || [];
  const find = (re) => headers.find((h) => re.test(h.toLowerCase()));
  const hName = find(/game\s*name/);
  const hVendor = find(/vendor|provider/);
  const hDate = find(/release/);
  const hStatus = find(/status/);

  if (!hName || !hVendor || !hDate) {
    return {
      error:
        "Couldn't find the needed columns. The CSV must include headers for Game Name, Vendor, and Released Date.",
    };
  }

  const rows = parsed.data
    .map((r) => ({
      name: (r[hName] || "").trim(),
      vendor: (r[hVendor] || "").trim(),
      date: (r[hDate] || "").trim(),
      status: hStatus ? (r[hStatus] || "").trim() : "",
    }))
    .filter((r) => r.name);

  return { rows };
}

const LS_KEY = "release-checker-custom-csv-v1";
const base = import.meta.env.BASE_URL || "/";

async function fetchBundled() {
  const res = await fetch(base + "gamelist.csv");
  if (!res.ok) throw new Error(`gamelist.csv: HTTP ${res.status}`);
  const text = await res.text();
  const out = parseDatabase(text);
  if (out.error) throw new Error(out.error);
  return out.rows;
}

async function fetchLiveZenith() {
  const res = await fetch("/api/zenith");
  if (!res.ok) throw new Error(`api/zenith: HTTP ${res.status}`);
  const data = await res.json();
  if (!data.rows || !data.rows.length) throw new Error("no rows");
  return data.rows;
}

/* ---------- provider documents (SS / Amb sheets) ---------- */

const SLOTS_KEY = "release-checker-sources-v1";
const DEFAULT_SLOTS = [
  {
    aggregator: "SS", provider: "JILI",
    url: "https://docs.google.com/spreadsheets/d/1kxsfZ9KFycb63Gkj-jrRleNw0rwHGEdhAGWBLKA-65E/edit?gid=2092046084#gid=2092046084",
  },
  {
    aggregator: "SS", provider: "TaDa",
    url: "https://docs.google.com/spreadsheets/d/1YfVQqjWga0txvHm2oU_CGuLJLtXY1qmI2q3kAR0uDeU/edit?gid=2124566733#gid=2124566733",
  },
];

const parseSheetUrl = (url) => {
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(url || "");
  if (!m) return null;
  const g = /[#?&]gid=(\d+)/.exec(url);
  return { id: m[1], gid: g ? g[1] : "0" };
};

const docLabelOf = (slot) => `${slot.provider} (${slot.aggregator})`;

// Text the provider documents put in the date column when a game has no
// public release: an availability status, not a broken date.
const AVAILABILITY_RE = /customer\s*limited|validation\s*in\s*progress|region\s*limited|coming\s*soon|^-+$/i;

const docCache = new Map(); // "id:gid" -> rows [{name, date}]

async function getDocRows(slot) {
  const ref = parseSheetUrl(slot.url);
  if (!ref) throw new Error("invalid sheet link");
  const key = `${ref.id}:${ref.gid}`;
  if (docCache.has(key)) return docCache.get(key);
  const res = await fetch(
    `https://docs.google.com/spreadsheets/d/${ref.id}/export?format=csv&gid=${ref.gid}`
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const grid = Papa.parse((await res.text()).trim(), { header: false }).data;
  // header row is not always row 1 (JILI has banner rows above it)
  let hdrIdx = -1;
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    if ((grid[i] || []).some((c) => /release/i.test(c || ""))) { hdrIdx = i; break; }
  }
  if (hdrIdx < 0) throw new Error("no Release Date column found");
  const headers = grid[hdrIdx].map((h) => (h || "").trim());
  const nameIdx = headers.findIndex((h) => /name/i.test(h) && !/chinese|中文/i.test(h));
  const dateIdx = headers.findIndex((h) => /release/i.test(h));
  if (nameIdx < 0 || dateIdx < 0) throw new Error("couldn't locate name/date columns");
  const rows = grid.slice(hdrIdx + 1)
    .map((r) => ({ name: (r[nameIdx] || "").trim(), date: (r[dateIdx] || "").trim() }))
    .filter((r) => r.name);
  docCache.set(key, rows);
  return rows;
}

function docSearch(game, rows, label) {
  const target = normName(game);
  let hits = rows.filter((r) => normName(r.name) === target);
  if (!hits.length) hits = rows.filter((r) => normName(r.name).includes(target));
  if (!hits.length) return { state: "notfound", date: "", doc: label, note: `not in the ${label} document` };

  const dateRaw = hits[0].date;
  let note = hits.length > 1 ? `${hits.length} matches — showing first` : "";
  const { d, precision } = parseAnyDate(dateRaw);
  if (!d) {
    if (AVAILABILITY_RE.test(dateRaw)) {
      return { state: "status", date: dateRaw, doc: label,
               note: `listed as “${dateRaw}” in the ${label} document (no public release date)` };
    }
    return { state: "check", date: dateRaw, doc: label, note: (note ? note + " · " : "") + "unreadable date" };
  }
  if (precision !== "full") note = (note ? note + " · " : "") + `source only gives the ${precision}`;
  if (d > today()) {
    const days = daysFromToday(d);
    return { state: "notyet", date: dateRaw, doc: label, precision,
             note: (note ? note + " · " : "") + (days === 1 ? "releases tomorrow" : `releases in ${days} days`) };
  }
  return { state: "released", date: dateRaw, doc: label, precision, note };
}

function findSlot(provider, slots) {
  const pv = normVendor(provider);
  if (!pv) return null;
  for (const s of slots) {
    const pk = normVendor(s.provider);
    if (pk && (pk === pv || pk.includes(pv) || pv.includes(pk))) return s;
  }
  for (const s of slots) {
    if (sameBrand(normVendor(s.provider), pv)) return s;
  }
  return null;
}

async function docLookup(game, provider, slots) {
  const valid = slots.filter((s) => s.provider.trim() && parseSheetUrl(s.url));
  if (!valid.length) return { state: "nosource", date: "", note: "no provider documents configured" };

  const searchOne = async (s) => {
    try {
      return docSearch(game, await getDocRows(s), docLabelOf(s));
    } catch (e) {
      return { state: "error", date: "", doc: docLabelOf(s), note: `couldn't read the ${s.provider} document (${e.message})` };
    }
  };

  const slot = findSlot(provider, valid);
  if (slot) return searchOne(slot);

  // No provider (or none configured for it): search every document by name.
  // Sister brands can list the same game (JILI carries TaDa titles in a
  // dateless "Customer Limited" section) — prefer readable dates.
  const found = [];
  for (const s of valid) {
    const res = await searchOne(s);
    if (res.state !== "notfound" && res.state !== "error") found.push(res);
  }
  if (found.length) {
    found.sort((a, b) =>
      (a.state === "released" || a.state === "notyet" ? 0 : 1) -
      (b.state === "released" || b.state === "notyet" ? 0 : 1));
    const res = found[0];
    let n = `found in the ${res.doc} document`;
    if (provider) n += " — verify the provider";
    if (found.length > 1) n += ` (also listed in ${found.slice(1).map((f) => f.doc).join(", ")})`;
    res.note = n + (res.note ? " · " + res.note : "");
    return res;
  }
  if (provider) return { state: "nosource", date: "", note: `no document configured for “${provider}”` };
  return { state: "notfound", date: "", note: "not in any configured document" };
}

/* ---------- channel routing: combine Zenith + document results ---------- */

const usableRes = (res) =>
  res && res.date && parseAnyDate(res.date).d !== null &&
  !["notfound", "nosource", "error", "skipped", "status", "nodate"].includes(res.state);

function combine(row, zen, doc) {
  const zenLabel = "Zenith";
  const docLabel = doc && doc.doc ? `${doc.doc} document` : "provider document";

  let routed = null, other = null, routedLabel = "", otherLabel = "";
  if (row.channel === "Zenith") {
    routed = zen; other = doc; routedLabel = zenLabel; otherLabel = docLabel;
  } else if (row.channel === "SS" || row.channel === "Amb") {
    routed = doc; other = zen; routedLabel = docLabel; otherLabel = zenLabel;
  }

  if (routed && usableRes(routed)) {
    const out = { state: routed.state, date: routed.date, note: routed.note || "", src: routedLabel };
    if (usableRes(other)) {
      const rd = parseAnyDate(routed.date).d, od = parseAnyDate(other.date).d;
      if (rd.getTime() !== od.getTime()) {
        out.note = (out.note ? out.note + " · " : "") + `${otherLabel}: ${fmtISO(other.date)}`;
      }
    }
    return out;
  }
  if (routed && usableRes(other)) {
    const reason = routed.note || `no date in the ${routedLabel}`;
    return {
      state: other.state, date: other.date, src: `${otherLabel} (fallback)`,
      note: `${reason} — using ${otherLabel}` + (other.note ? " · " + other.note : ""),
    };
  }
  if (!routed) {
    // No channel prefix pasted: show whichever source knows the game.
    const best = usableRes(zen) ? zen : usableRes(doc) ? doc : null;
    if (best) {
      const bestLabel = best === zen ? zenLabel : docLabel;
      const rest = best === zen ? doc : zen;
      const restLabel = best === zen ? docLabel : zenLabel;
      const out = { state: best.state, date: best.date, note: best.note || "", src: `${bestLabel} (no aggregator pasted)` };
      if (usableRes(rest)) out.note = (out.note ? out.note + " · " : "") + `${restLabel}: ${fmtISO(rest.date)}`;
      return out;
    }
    return { state: "notfound", date: "", src: "", note: "not in Zenith or the provider documents — search the web" };
  }
  const notes = [routed && routed.note, other && other.note].filter(Boolean).join(" · ");
  return { state: "notfound", date: "", src: "", note: (notes ? notes + " — " : "") + "search the web" };
}

/* ---------- styles ---------- */

const C = {
  bg: "var(--bg)",
  panel: "var(--panel)",
  panel2: "var(--panel-2)",
  ink: "var(--ink)",
  sub: "var(--sub)",
  line: "var(--line)",
  felt: "var(--accent)",
  feltSoft: "var(--ok-bg)",
  amber: "var(--warn-fg)",
  amberSoft: "var(--warn-bg)",
  red: "var(--danger-fg)",
  redSoft: "var(--danger-bg)",
  grey: "var(--muted-fg)",
  greySoft: "var(--muted-bg)",
  blue: "var(--link)",
};

const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const sans = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const STATE_META = {
  released: { label: "RELEASED", fg: "var(--ok-fg)", bg: "var(--ok-bg)" },
  notyet:   { label: "NOT YET RELEASED", fg: "#FFFFFF", bg: "var(--danger-solid)" },
  removed:  { label: "REMOVED", fg: "var(--danger-fg)", bg: "var(--danger-bg)" },
  check:    { label: "CHECK MANUALLY", fg: "var(--warn-fg)", bg: "var(--warn-bg)" },
  notfound: { label: "NOT FOUND", fg: "var(--muted-fg)", bg: "var(--muted-bg)" },
  nodate:   { label: "NO DATE", fg: "var(--muted-fg)", bg: "var(--muted-bg)" },
  skipped:  { label: "SKIPPED", fg: "var(--muted-fg)", bg: "var(--muted-bg)" },
};

const label = {
  fontFamily: sans,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
  color: C.sub,
};

const btn = (primary) => ({
  fontFamily: sans,
  fontSize: 13,
  fontWeight: 600,
  padding: "9px 18px",
  borderRadius: 999,
  cursor: "pointer",
  border: primary ? "1px solid transparent" : `1px solid ${C.line}`,
  background: primary ? "var(--btn-p-bg)" : C.panel,
  color: primary ? "var(--btn-p-fg)" : C.ink,
});

const slotInput = {
  fontFamily: mono,
  fontSize: 12,
  padding: "6px 10px",
  border: `1px solid ${C.line}`,
  borderRadius: 8,
  boxSizing: "border-box",
  background: C.panel2,
};

const srcChipStyle = (source) => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontFamily: mono,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.04em",
  padding: "4px 11px",
  borderRadius: 999,
  whiteSpace: "nowrap",
  background: source === "live" ? "var(--ok-bg)" : source === "custom" ? "var(--warn-bg)" : "var(--muted-bg)",
  color: source === "live" ? "var(--ok-fg)" : source === "custom" ? "var(--warn-fg)" : "var(--muted-fg)",
});

const SRC_CHIP_TEXT = {
  live: "LIVE · AIRTABLE",
  custom: "CUSTOM CSV",
  bundled: "BUNDLED CSV",
};

/* ---------- component ---------- */

export default function ReleaseDateChecker() {
  const [db, setDb] = useState(null); // { rows, source: "bundled" | "custom" | "live" }
  const [version, setVersion] = useState(null); // { updated, source } from version.json
  const [dbMsg, setDbMsg] = useState("");
  const [loadingDb, setLoadingDb] = useState(true);
  const [showDbPaste, setShowDbPaste] = useState(false);
  const [dbPasteText, setDbPasteText] = useState("");

  const [slots, setSlots] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SLOTS_KEY) || "null");
      if (Array.isArray(saved) && saved.length) return saved;
    } catch (e) { /* fall through to defaults */ }
    return DEFAULT_SLOTS.map((s) => ({ ...s }));
  });

  const [input, setInput] = useState("");
  const [results, setResults] = useState(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState("");
  const fileRef = useRef(null);

  // <html class="rdc-light"> is the single source of truth for the theme
  const [light, setLight] = useState(() =>
    document.documentElement.classList.contains("rdc-light")
  );
  useEffect(() => {
    document.documentElement.classList.toggle("rdc-light", light);
    try { localStorage.setItem("rdc_theme", light ? "light" : "dark"); } catch (e) { /* ignore */ }
  }, [light]);

  useEffect(() => {
    try { localStorage.setItem(SLOTS_KEY, JSON.stringify(slots)); } catch (e) { /* ignore */ }
  }, [slots]);

  useEffect(() => {
    (async () => {
      fetch(base + "version.json")
        .then((r) => (r.ok ? r.json() : null))
        .then((v) => v && setVersion(v))
        .catch(() => {});
      try {
        const savedCsv = localStorage.getItem(LS_KEY);
        if (savedCsv) {
          const out = parseDatabase(savedCsv);
          if (!out.error) {
            setDb({ rows: out.rows, source: "custom" });
            setLoadingDb(false);
            return;
          }
          localStorage.removeItem(LS_KEY);
        }
      } catch (e) { /* localStorage unavailable — fall through */ }
      try {
        const rows = await fetchLiveZenith();
        setDb({ rows, source: "live" });
        setLoadingDb(false);
        return;
      } catch (e) { /* no token configured or API trouble — bundled CSV */ }
      try {
        const rows = await fetchBundled();
        setDb({ rows, source: "bundled" });
      } catch (e) {
        setDbMsg(`Couldn't load the bundled game list (${e.message}). Upload a CSV below.`);
      }
      setLoadingDb(false);
    })();
  }, []);

  const byName = useMemo(() => (db ? buildIndex(db.rows) : null), [db]);
  const vendorKeys = useMemo(() => {
    if (!db) return [];
    return [...new Set(db.rows.map((r) => normVendor(r.vendor)).filter((v) => v.length >= 2))];
  }, [db]);

  const handleCsvText = (text) => {
    const out = parseDatabase(text);
    if (out.error) { setDbMsg(out.error); return; }
    setDb({ rows: out.rows, source: "custom" });
    try {
      localStorage.setItem(LS_KEY, text);
      setDbMsg(`${out.rows.length.toLocaleString()} games loaded from your CSV — saved in this browser until you click Clear.`);
    } catch (e) {
      setDbMsg(`${out.rows.length.toLocaleString()} games loaded (couldn't save for next session — reload the CSV next time).`);
    }
    setShowDbPaste(false);
    setDbPasteText("");
    setResults(null);
  };

  const handleFile = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => handleCsvText(reader.result);
    reader.readAsText(f);
    e.target.value = "";
  };

  const clearDb = async () => {
    try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
    setResults(null);
    setLoadingDb(true);
    setDb(null);
    try {
      const rows = await fetchLiveZenith();
      setDb({ rows, source: "live" });
      setDbMsg("Reverted to the live Zenith list.");
    } catch (e) {
      try {
        const rows = await fetchBundled();
        setDb({ rows, source: "bundled" });
        setDbMsg("Reverted to the bundled game list.");
      } catch (e2) {
        setDbMsg(`Couldn't load the game list (${e2.message}). Upload a CSV below.`);
      }
    }
    setLoadingDb(false);
  };

  const run = async () => {
    if (!db || running) return;
    setRunning(true);
    try {
      const parsedRows = parseInput(input, vendorKeys);
      const out = [];
      for (const r of parsedRows) {
        if (r.empty || r.header) {
          out.push({ ...r, state: "skipped", date: "", note: r.header ? "Header row" : "" });
          continue;
        }
        if (!normName(r.game)) {
          out.push({ ...r, state: "skipped", date: "", note: "Couldn't read a game name from this row" });
          continue;
        }
        const zen = lookupOne(r, db.rows, byName);
        const pool = r.channel === "SS" || r.channel === "Amb"
          ? slots.filter((s) => s.aggregator === r.channel)
          : slots;
        const doc = await docLookup(r.game, r.provider, pool.length ? pool : slots);
        out.push({
          ...r, ...combine(r, zen, doc),
          zenDate: zen.date || "", docDate: doc.date || "", docName: doc.doc || "",
        });
      }
      setResults(out);
      setCopied("");
    } finally {
      setRunning(false);
    }
  };

  const doCopy = async (mode) => {
    if (!results) return;
    const lines = results.map((r) => {
      if (r.empty || r.header) return "";
      const d = r.state === "notfound" ? "NOT FOUND" : r.date || "";
      if (mode === "convdates") return d === "NOT FOUND" ? d : toSheetDate(d);
      return d === "NOT FOUND" ? d : fmtISO(d);
    });
    const text = lines.join("\n");
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; }
    catch (e) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch (e2) { /* ignore */ }
    }
    setCopied(ok ? mode : "fail");
    if (ok) setTimeout(() => setCopied(""), 2500);
  };

  const counts = useMemo(() => {
    if (!results) return null;
    const c = { released: 0, notyet: 0, removed: 0, check: 0, notfound: 0 };
    results.forEach((r) => {
      if (c[r.state] !== undefined) c[r.state]++;
      if (r.state === "nodate") c.check++;
    });
    return c;
  }, [results]);

  const activeRows = results ? results.filter((r) => !r.empty && !r.header) : [];

  const setSlot = (i, patch) =>
    setSlots((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const dbSourceText =
    !db ? "" :
    db.source === "custom" ? "custom list (saved in this browser)" :
    db.source === "live" ? "live from Airtable" :
    version ? `updated ${version.updated} · ${version.source}` : "bundled list";

  return (
    <div style={{ background: C.bg, minHeight: "100vh", padding: "24px 16px", fontFamily: sans, color: C.ink }}>
      <div style={{ maxWidth: 1060, margin: "0 auto" }}>

        {/* header */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
          <div>
            <div style={{ ...label, color: C.felt }}>DX · Game Sync</div>
            <h1 style={{ margin: "2px 0 0", fontSize: 26, fontWeight: 800, letterSpacing: "-0.01em" }}>
              Release Date Checker
            </h1>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {db && (
              <>
                <span style={srcChipStyle(db.source)}>
                  <span style={{ width: 7, height: 7, borderRadius: 99, background: "currentColor" }} />
                  {SRC_CHIP_TEXT[db.source] || db.source}
                </span>
                <span style={{ fontFamily: mono, fontSize: 12, color: C.sub }}>
                  {db.rows.length.toLocaleString()} games · {dbSourceText}
                </span>
              </>
            )}
            <button
              onClick={() => setLight((v) => !v)}
              title={light ? "Switch to dark mode" : "Switch to light mode"}
              style={{ ...btn(false), padding: "5px 12px", fontSize: 13, lineHeight: 1.4 }}
            >
              {light ? "☾" : "☀"}
            </button>
          </div>
        </div>

        {/* input sources panel */}
        <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 20, marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div style={label}>Step 1 — Input sources (where the release dates come from)</div>
                {db && !loadingDb && (
                  <span style={srcChipStyle(db.source)}>
                    <span style={{ width: 6, height: 6, borderRadius: 99, background: "currentColor" }} />
                    {db.source === "live" ? "ZENITH: LIVE FROM AIRTABLE" : db.source === "custom" ? "ZENITH: CUSTOM CSV" : "ZENITH: BUNDLED CSV"}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 13, color: C.sub, marginTop: 4 }}>
                {loadingDb
                  ? "Loading the Zenith game list…"
                  : db && db.source === "custom"
                  ? "Zenith: using your uploaded CSV. Click Clear to revert."
                  : db && db.source === "live"
                  ? "Zenith: reading the ONEAPI Airtable live. Upload a CSV only to override it temporarily."
                  : db
                  ? "Zenith: bundled monthly export (live Airtable not configured). Upload a CSV to override."
                  : "Couldn't load the Zenith list — upload the Airtable CSV export instead."}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button style={btn(!db)} onClick={() => fileRef.current && fileRef.current.click()}>
                {db ? "Replace CSV" : "Upload CSV"}
              </button>
              <button style={btn(false)} onClick={() => setShowDbPaste((v) => !v)}>
                Paste CSV text
              </button>
              {db && db.source === "custom" && (
                <button style={{ ...btn(false), color: C.red }} onClick={clearDb}>
                  Clear
                </button>
              )}
            </div>
          </div>
          <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={handleFile} />
          {showDbPaste && (
            <div style={{ marginTop: 12 }}>
              <textarea
                value={dbPasteText}
                onChange={(e) => setDbPasteText(e.target.value)}
                placeholder="Paste the full CSV text here (including the header row)…"
                style={{ width: "100%", minHeight: 110, boxSizing: "border-box", fontFamily: mono, fontSize: 12, padding: 10, border: `1px solid ${C.line}`, borderRadius: 6, resize: "vertical" }}
              />
              <button style={{ ...btn(true), marginTop: 8 }} onClick={() => handleCsvText(dbPasteText)}>
                Load pasted CSV
              </button>
            </div>
          )}
          {dbMsg && <div style={{ marginTop: 10, fontSize: 13, color: C.blue }}>{dbMsg}</div>}

          {/* provider document slots */}
          <div style={{ marginTop: 16, borderTop: `1px solid ${C.line}`, paddingTop: 14 }}>
            <div style={{ fontSize: 13, color: C.sub, marginBottom: 8 }}>
              <strong style={{ color: C.ink }}>Provider documents</strong> — the release-date sheets the providers
              publish per aggregator. <code style={{ fontFamily: mono, fontSize: 12 }}>SS:</code>/<code style={{ fontFamily: mono, fontSize: 12 }}>amb:</code> rows
              resolve from these; <code style={{ fontFamily: mono, fontSize: 12 }}>zen:</code> rows resolve from the Zenith list.
              Paste a Google Sheets link (with its <code style={{ fontFamily: mono, fontSize: 12 }}>gid=</code>) to repoint a slot.
            </div>
            {slots.map((s, i) => {
              const ref = parseSheetUrl(s.url);
              return (
                <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
                  <select
                    value={s.aggregator}
                    onChange={(e) => setSlot(i, { aggregator: e.target.value })}
                    style={{ ...slotInput, width: 70 }}
                  >
                    <option>SS</option>
                    <option>Amb</option>
                  </select>
                  <input
                    value={s.provider}
                    placeholder="Provider"
                    onChange={(e) => setSlot(i, { provider: e.target.value })}
                    style={{ ...slotInput, width: 100 }}
                  />
                  <input
                    value={s.url}
                    placeholder="https://docs.google.com/spreadsheets/d/…?gid=…"
                    onChange={(e) => setSlot(i, { url: e.target.value })}
                    style={{ ...slotInput, flex: "1 1 260px", color: ref ? C.ink : C.red }}
                  />
                  {ref && (
                    <a href={s.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: C.blue, fontWeight: 600, whiteSpace: "nowrap" }}>
                      open ↗
                    </a>
                  )}
                  <button
                    onClick={() => setSlots((prev) => prev.filter((_, j) => j !== i))}
                    title="Remove this source"
                    style={{ ...btn(false), padding: "4px 9px", color: C.red, fontSize: 12 }}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
            <button
              style={{ ...btn(false), padding: "6px 12px", fontSize: 12 }}
              onClick={() => setSlots((prev) => [...prev, { aggregator: "SS", provider: "", url: "" }])}
            >
              + Add a source slot
            </button>
          </div>
        </div>

        {/* input panel */}
        <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 20, marginBottom: 16, opacity: db ? 1 : 0.55 }}>
          <div style={label}>Step 2 — Paste rows from the game sync sheet</div>
          <div style={{ fontSize: 13, color: C.sub, margin: "4px 0 10px" }}>
            Drag-select the rows in Google Sheets — extra columns are fine. The aggregator prefix in the provider
            cell (<code style={{ fontFamily: mono, fontSize: 12 }}>zen:</code> / <code style={{ fontFamily: mono, fontSize: 12 }}>SS:</code> / <code style={{ fontFamily: mono, fontSize: 12 }}>amb:</code>)
            decides which source answers for that row; the other source is shown alongside as a cross-check.
            Dates, checkboxes, links, and BO group cells are ignored automatically.
          </div>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={!db}
            placeholder={"Fri, 19/06\tMonster Quest\tzen: Big Time Gaming\tBRKZ\nFri, 19/06\tLucky Tiger 2\tSS: Tada\tBRKZ"}
            style={{ width: "100%", minHeight: 150, boxSizing: "border-box", fontFamily: mono, fontSize: 13, padding: 12, border: `1px solid ${C.line}`, borderRadius: 10, resize: "vertical", background: db ? C.panel2 : C.greySoft }}
          />
          <div style={{ marginTop: 12 }}>
            <button style={btn(true)} disabled={!db || !input.trim() || running} onClick={run}>
              {running ? "Looking up…" : "Find release dates"}
            </button>
          </div>
        </div>

        {/* results */}
        {results && (
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
              <div style={label}>Step 3 — Results ({activeRows.length} games)</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button style={btn(true)} onClick={() => doCopy("convdates")}>
                  {copied === "convdates" ? "Copied ✓" : "Convert & copy dates column"}
                </button>
                <button style={btn(false)} onClick={() => doCopy("dates")}>
                  {copied === "dates" ? "Copied ✓" : "Copy dates column"}
                </button>
              </div>
            </div>
            {copied === "fail" && (
              <div style={{ fontSize: 13, color: C.red, marginBottom: 8 }}>
                Couldn't access the clipboard — select the dates from the table instead.
              </div>
            )}

            {counts && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                {[
                  ["released", counts.released],
                  ["notyet", counts.notyet],
                  ["removed", counts.removed],
                  ["check", counts.check],
                  ["notfound", counts.notfound],
                ].map(([k, n]) =>
                  n > 0 ? (
                    <div key={k} style={{ background: STATE_META[k].bg, color: STATE_META[k].fg, borderRadius: 6, padding: "5px 10px", fontFamily: mono, fontSize: 12, fontWeight: 700 }}>
                      {n} {STATE_META[k].label}
                    </div>
                  ) : null
                )}
              </div>
            )}

            {counts && counts.notyet > 0 && (
              <div style={{ background: C.redSoft, border: `1px solid ${C.red}`, color: C.red, borderRadius: 6, padding: "10px 12px", fontSize: 13, fontWeight: 600, marginBottom: 14 }}>
                ⚠ {counts.notyet} game{counts.notyet > 1 ? "s are" : " is"} not released yet — do not open on MP.
              </div>
            )}

            <div style={{ overflowX: "auto", maxHeight: 520, overflowY: "auto", border: `1px solid ${C.line}`, borderRadius: 8 }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
                <thead>
                  <tr>
                    {["Game Name", "Aggre : Provider", "Zenith", "Provider doc", "Released Date", "Status", "Note"].map((h) => (
                      <th key={h} style={{ ...label, fontSize: 10, textAlign: "left", padding: "8px 10px", border: `1px solid ${C.line}`, background: C.panel2, position: "sticky", top: 0, zIndex: 1, whiteSpace: "nowrap", minWidth: h === "Note" ? 260 : h === "Game Name" ? 140 : undefined }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => {
                    if (r.empty) return null;
                    if (r.header)
                      return (
                        <tr key={i}>
                          <td colSpan={7} style={{ padding: "6px 10px", fontSize: 12, color: C.sub, border: `1px solid ${C.line}` }}>header row (skipped)</td>
                        </tr>
                      );
                    const meta = STATE_META[r.state] || STATE_META.skipped;
                    const cell = { padding: "7px 10px", border: `1px solid ${C.line}`, verticalAlign: "middle" };
                    return (
                      <tr key={i} style={{ background: r.state === "notyet" ? "var(--danger-row)" : "transparent" }}>
                        <td style={{ ...cell, fontWeight: 600 }}>{r.game}</td>
                        <td style={{ ...cell, color: C.sub }}>{r.providerRaw || r.provider}</td>
                        <td style={{ ...cell, fontFamily: mono, fontSize: 12, color: C.sub, whiteSpace: "nowrap" }}>
                          {r.zenDate ? fmtISO(r.zenDate) : "—"}
                        </td>
                        <td style={{ ...cell, fontFamily: mono, fontSize: 12, color: C.sub }}>
                          {r.docDate ? `${fmtISO(r.docDate)}${r.docName ? ` · ${r.docName}` : ""}` : "—"}
                        </td>
                        <td style={{ ...cell, fontFamily: mono, fontWeight: 700, whiteSpace: "nowrap" }}>
                          {r.date ? fmtISO(r.date) : "—"}
                        </td>
                        <td style={{ ...cell, whiteSpace: "nowrap" }}>
                          <span style={{ background: meta.bg, color: meta.fg, borderRadius: 5, padding: "2px 8px", fontFamily: mono, fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>
                            {meta.label}
                          </span>
                        </td>
                        <td style={{ ...cell, fontSize: 11, color: C.sub }}>
                          {r.src && <span style={{ color: C.felt, fontWeight: 600 }}>from {r.src}</span>}
                          {r.src && r.note ? " · " : ""}
                          {r.note}
                          {r.state === "notfound" && (
                            <>
                              {" "}
                              <a
                                href={`https://www.google.com/search?q=${encodeURIComponent([r.game, r.provider, "release date"].filter(Boolean).join(" "))}`}
                                target="_blank"
                                rel="noreferrer"
                                style={{ fontSize: 11, color: C.blue, fontWeight: 600, whiteSpace: "nowrap" }}
                              >
                                Search web ↗
                              </a>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: 12, fontSize: 12, color: C.sub }}>
              Both buttons copy one line per pasted row, in the same order — paste straight into the Note &amp; remarks
              column. Each row's date comes from its own aggregator channel (zen: → Zenith, SS:/amb: → that
              aggregator's provider document), falling back to the other source when the channel has no date — the
              “from …” tag on each row says which. “Convert &amp; copy” formats dates like the sheet (2026-07-10 → Fri, 10/07);
              “Copy dates column” copies them as displayed (yyyy-mm-dd).
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
