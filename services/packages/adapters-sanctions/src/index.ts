import { XMLParser } from "fast-xml-parser";
import type { ListStatus, SanctionsListId, SanctionsListPort, SanctionsMatch, SanctionsQuery } from "@dc/ports";
import { nameMatchScore, sha256Hex } from "@dc/rules";

/** One sanctioned subject, normalised from any source list. */
export type ListEntry = {
  entryId: string;
  names: string[];
  birthDates: string[]; // ISO date or yyyy
  citizenships: string[];
  programme?: string;
};

export type ParsedList = { entries: ListEntry[]; version: string };

const toArray = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

// ------------------------------------------------------------------ parsers

/** EU Financial Sanctions Files (FSF) consolidated XML, schema 1.1. */
export function parseEuFsf(xml: string): ParsedList {
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" }).parse(xml);
  const root = doc.export ?? doc;
  const entries: ListEntry[] = toArray(root.sanctionEntity)
    .filter((e: any) => e.subjectType?.code === "person" || e.subjectType?.classificationCode === "P")
    .map((e: any) => ({
      entryId: `EU-${e.logicalId ?? e.euReferenceNumber}`,
      names: toArray(e.nameAlias).map((n: any) => n.wholeName).filter(Boolean),
      birthDates: toArray(e.birthdate).map((b: any) => b.birthdate ?? b.year).filter(Boolean).map(String),
      citizenships: toArray(e.citizenship).map((c: any) => c.countryIso2Code).filter(Boolean),
      programme: toArray(e.regulation)[0]?.programme,
    }));
  return { entries, version: root.generationDate ?? sha256Hex(xml).slice(0, 12) };
}

/** UN Security Council consolidated list XML. */
export function parseUn(xml: string): ParsedList {
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" }).parse(xml);
  const root = doc.CONSOLIDATED_LIST;
  const entries: ListEntry[] = toArray(root?.INDIVIDUALS?.INDIVIDUAL).map((i: any) => {
    const main = [i.FIRST_NAME, i.SECOND_NAME, i.THIRD_NAME, i.FOURTH_NAME].filter(Boolean).join(" ");
    const aliases = toArray(i.INDIVIDUAL_ALIAS)
      .map((a: any) => a.ALIAS_NAME)
      .filter((a: unknown) => typeof a === "string" && a.length > 0);
    return {
      entryId: `UN-${i.REFERENCE_NUMBER ?? i.DATAID}`,
      names: [main, ...aliases].filter(Boolean),
      birthDates: toArray(i.INDIVIDUAL_DATE_OF_BIRTH)
        .map((d: any) => d.DATE ?? d.YEAR)
        .filter(Boolean)
        .map(String),
      citizenships: toArray(i.NATIONALITY?.VALUE).map(String),
      programme: i.UN_LIST_TYPE,
    };
  });
  return { entries, version: root?.dateGenerated ?? sha256Hex(xml).slice(0, 12) };
}

/** Minimal RFC 4180 CSV parser (OFAC files quote fields containing commas). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.some((x) => x.trim()));
}

/** OFAC SDN.CSV (+ optional ALT.CSV). Individuals only; DOB is embedded in the remarks column. */
export function parseOfac(sdnCsv: string, altCsv?: string): ParsedList {
  const clean = (s: string | undefined) => (s && s.trim() !== "-0-" ? s.trim() : "");
  const byId = new Map<string, ListEntry>();
  for (const r of parseCsv(sdnCsv)) {
    const [id, name, type, programme, , , , , , , , remarks] = r;
    if (clean(type).toLowerCase() !== "individual" || !id) continue;
    // OFAC names are "SURNAME, Given Names"
    const [sur, given] = clean(name).split(",").map((x) => x.trim());
    const dobs = [...clean(remarks).matchAll(/DOB (\d{1,2} [A-Za-z]{3} \d{4}|\d{4})/g)].map((m) => m[1]!);
    byId.set(id, {
      entryId: `OFAC-${id}`,
      names: [given ? `${given} ${sur}` : (sur ?? "")],
      birthDates: dobs.map((d) => (/^\d{4}$/.test(d) ? d : new Date(`${d} UTC`).toISOString().slice(0, 10))),
      citizenships: [...clean(remarks).matchAll(/nationality ([A-Za-z ]+?)[;.]/g)].map((m) => m[1]!),
      programme: clean(programme),
    });
  }
  if (altCsv)
    for (const [id, , , altName] of parseCsv(altCsv)) {
      const e = id && byId.get(id);
      if (!e || !clean(altName)) continue;
      const [sur, given] = clean(altName).split(",").map((x) => x.trim());
      e.names.push(given ? `${given} ${sur}` : (sur ?? ""));
    }
  return { entries: [...byId.values()], version: sha256Hex(sdnCsv).slice(0, 12) };
}

/** ONPCSB national list export, CSV: name,birthDate,citizenship,reference. */
export function parseOnpcsb(csv: string): ParsedList {
  const rows = parseCsv(csv);
  const body = rows[0]?.[0]?.toLowerCase().includes("name") || rows[0]?.[0]?.toLowerCase().includes("nume") ? rows.slice(1) : rows;
  return {
    entries: body.map(([name = "", birth = "", cit = "", ref = ""], i) => ({
      entryId: `ONPCSB-${ref || i + 1}`,
      names: [name],
      birthDates: birth ? [birth] : [],
      citizenships: cit ? [cit] : [],
    })),
    version: sha256Hex(csv).slice(0, 12),
  };
}

// ------------------------------------------------------------------ matching

export const scoreName = nameMatchScore;

/** Date-of-birth compatibility: same year (or exact date) keeps the score, a different year lowers it. */
function dobFactor(queryDob: string | undefined, dobs: string[]): number {
  if (!queryDob || !dobs.length) return 1;
  const y = queryDob.slice(0, 4);
  if (dobs.some((d) => d === queryDob || d === y || d.startsWith(y))) return 1;
  return 0.75;
}

export function searchEntries(entries: ListEntry[], q: SanctionsQuery, listId: string, threshold: number): SanctionsMatch[] {
  const out: SanctionsMatch[] = [];
  for (const e of entries) {
    let best = 0;
    let bestName = "";
    for (const n of e.names) {
      const s = scoreName(q.fullName, n);
      if (s > best) (best = s), (bestName = n);
    }
    const score = best * dobFactor(q.birthDate, e.birthDates);
    if (score >= threshold)
      out.push({ listId, entryId: e.entryId, matchedName: bestName, score, birthDates: e.birthDates, citizenships: e.citizenships, programme: e.programme });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 10);
}

// ------------------------------------------------------------------ adapter

export type ListSource = {
  listId: SanctionsListId;
  /** Loads raw content and parses it; throws when the source is unreachable. */
  load: () => Promise<ParsedList>;
  sourceName: string;
};

/**
 * Real sanctions list adapter: downloads the official file, caches it in memory and refreshes
 * it after `refreshHours`. When the source cannot be loaded, status() reports "unavailable"
 * and the screening agent blocks the check instead of silently passing it.
 */
export class SanctionsListAdapter implements SanctionsListPort {
  readonly listId: SanctionsListId;
  private cache?: { list: ParsedList; fetchedAt: Date };
  private lastError?: string;
  private loading?: Promise<void>;

  constructor(
    private src: ListSource,
    private opts: { refreshHours: number; threshold: number; now?: () => Date },
  ) {
    this.listId = src.listId;
  }

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  private async ensure() {
    const fresh = this.cache && this.now().getTime() - this.cache.fetchedAt.getTime() < this.opts.refreshHours * 3_600_000;
    if (fresh) return;
    this.loading ??= this.src
      .load()
      .then((list) => {
        this.cache = { list, fetchedAt: this.now() };
        this.lastError = undefined;
      })
      .catch((e) => {
        this.lastError = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        this.loading = undefined;
      });
    await this.loading;
  }

  async status(): Promise<ListStatus> {
    await this.ensure();
    if (!this.cache) return { listId: this.listId, status: "unavailable", reason: this.lastError ?? "not loaded", simulated: false };
    return {
      listId: this.listId,
      status: "ok",
      version: this.cache.list.version,
      fetchedAt: this.cache.fetchedAt.toISOString(),
      entries: this.cache.list.entries.length,
      simulated: false,
      ...(this.lastError ? { reason: `refresh failed, serving cached copy: ${this.lastError}` } : {}),
    };
  }

  async search(q: SanctionsQuery): Promise<SanctionsMatch[]> {
    await this.ensure();
    if (!this.cache) throw new Error(`${this.listId} list unavailable`);
    return searchEntries(this.cache.list.entries, q, this.listId, this.opts.threshold);
  }
}

async function fetchText(url: string, timeoutMs = 60_000): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.text();
}

export const DEFAULT_LIST_URLS = {
  eu: "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw",
  un: "https://scsanctions.un.org/resources/xml/en/consolidated.xml",
  ofacSdn: "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV",
  ofacAlt: "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ALT.CSV",
};

export function officialListSources(cfg: {
  euUrl?: string;
  unUrl?: string;
  ofacSdnUrl?: string;
  ofacAltUrl?: string;
  /** Path to the ONPCSB export; when absent the ONPCSB check is blocked. */
  onpcsbFile?: string;
}): ListSource[] {
  return [
    { listId: "eu", sourceName: "EU Financial Sanctions Files", load: async () => parseEuFsf(await fetchText(cfg.euUrl ?? DEFAULT_LIST_URLS.eu)) },
    { listId: "un", sourceName: "UN Security Council Consolidated List", load: async () => parseUn(await fetchText(cfg.unUrl ?? DEFAULT_LIST_URLS.un)) },
    {
      listId: "ofac",
      sourceName: "OFAC SDN List",
      load: async () => {
        const [sdn, alt] = await Promise.all([fetchText(cfg.ofacSdnUrl ?? DEFAULT_LIST_URLS.ofacSdn), fetchText(cfg.ofacAltUrl ?? DEFAULT_LIST_URLS.ofacAlt).catch(() => undefined)]);
        return parseOfac(sdn, alt);
      },
    },
    {
      listId: "onpcsb",
      sourceName: "ONPCSB national list",
      load: async () => {
        if (!cfg.onpcsbFile) throw new Error("ONPCSB export not configured (ONPCSB_LIST_FILE)");
        const f = Bun.file(cfg.onpcsbFile);
        if (!(await f.exists())) throw new Error(`ONPCSB export not found at ${cfg.onpcsbFile}`);
        return parseOnpcsb(await f.text());
      },
    },
  ];
}
