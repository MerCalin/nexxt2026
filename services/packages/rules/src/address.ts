import { foldForMatch } from "./text";

/** Romanian address components, as printed on CI / utility bills / statements. */
export type Address = {
  county?: string; // JUD.
  locality?: string; // MUN. / ORȘ. / COM. / SAT
  sector?: string; // Bucharest SECT.
  street?: string;
  number?: string;
  block?: string;
  staircase?: string;
  floor?: string;
  apartment?: string;
};

const STREET_TYPES = ["STRADA", "STR", "BULEVARDUL", "BD", "BDUL", "B DUL", "CALEA", "SOSEAUA", "SOS", "SPLAIUL", "ALEEA", "AL", "INTRAREA", "PIATA", "PTA"];

/** Field markers → component. Order matters: longer forms first. */
const MARKERS: [RegExp, keyof Address][] = [
  [/\bJUD(?:ETUL)?\b/, "county"],
  [/\b(?:MUN(?:ICIPIUL)?|ORS|ORAS(?:UL)?|COM(?:UNA)?|SAT(?:UL)?|LOC(?:ALITATEA)?)\b/, "locality"],
  [/\bSECT?(?:OR(?:UL)?)?\b/, "sector"],
  [new RegExp(`\\b(?:${STREET_TYPES.join("|")})\\b`), "street"],
  [/\bNR\b/, "number"],
  [/\bBL(?:OC)?\b/, "block"],
  [/\bSC(?:ARA)?\b/, "staircase"],
  [/\bET(?:AJ)?\b/, "floor"],
  [/\bAP(?:ARTAMENT)?\b/, "apartment"],
];

const SINGLE_TOKEN = new Set<keyof Address>(["sector", "number", "block", "staircase", "floor", "apartment"]);

export function parseAddress(raw: string): Address {
  const s = ` ${foldForMatch(raw)} `;
  const hits: { idx: number; end: number; key: keyof Address }[] = [];
  for (const [re, key] of MARKERS) {
    const g = new RegExp(re.source, "g");
    for (const m of s.matchAll(g)) hits.push({ idx: m.index!, end: m.index! + m[0].length, key });
  }
  hits.sort((a, b) => a.idx - b.idx);
  const out: Address = {};
  hits.forEach((h, i) => {
    const next = hits[i + 1]?.idx ?? s.length;
    let value = s.slice(h.end, next).trim();
    // short components are a single token; anything after it is a locality without a marker
    if (SINGLE_TOKEN.has(h.key)) value = value.split(" ")[0] ?? "";
    if (value && out[h.key] === undefined) out[h.key] = value;
  });
  if (out.locality === "BUCURESTI" || /\bBUCURESTI\b/.test(s)) out.locality = "BUCURESTI";
  return out;
}

export type AddressComparison = "same" | "same_building" | "same_street" | "different" | "insufficient";

export function compareAddresses(a: string, b: string): AddressComparison {
  const x = parseAddress(a);
  const y = parseAddress(b);
  if (!x.street || !y.street || !x.number || !y.number) {
    return foldForMatch(a) === foldForMatch(b) ? "same" : "insufficient";
  }
  const eq = (k: keyof Address) => (x[k] ?? "") === (y[k] ?? "");
  const loose = (k: keyof Address) => !x[k] || !y[k] || x[k] === y[k];
  if (!loose("locality") || !loose("county")) return "different";
  if (x.street !== y.street) return "different";
  if (x.number !== y.number) return "same_street";
  if (eq("block") && eq("staircase") && eq("apartment")) return "same";
  return "same_building";
}

export const normalizeAddress = (raw: string): string => {
  const a = parseAddress(raw);
  const parts = (Object.keys(a) as (keyof Address)[]).filter((k) => a[k]).map((k) => `${k}=${a[k]}`);
  return parts.length ? parts.join(";") : foldForMatch(raw);
};
