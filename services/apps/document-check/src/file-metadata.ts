import { inflateSync } from "node:zlib";
import type { FileMetadata } from "@dc/contracts";

/** "D:20261001103000+02'00'" → ISO timestamp */
function pdfDate(s: string | undefined): string | undefined {
  const m = s?.match(/D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?([Z+-])?(\d{2})?'?(\d{2})?/);
  if (!m) return undefined;
  const [, y, mo, d, h = "00", mi = "00", se = "00", tz, th = "00", tm = "00"] = m;
  const offset = !tz || tz === "Z" ? "Z" : `${tz}${th}:${tm}`;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}${offset}`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** PDF literal "(text)" or hex "<FEFF...>" string → JS string */
function pdfString(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith("<")) {
    const hex = raw.slice(1, -1).replace(/\s/g, "");
    const bytes = hex.match(/../g)?.map((b) => Number.parseInt(b, 16)) ?? [];
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      let s = "";
      for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
      return s;
    }
    return String.fromCharCode(...bytes);
  }
  return raw.slice(1, -1).replace(/\\([()\\])/g, "$1");
}

function pdfInfo(text: string, key: string): string | undefined {
  // the last occurrence wins: incremental updates append a new Info dictionary
  const re = new RegExp(`/${key}\\s*(\\((?:\\\\.|[^\\\\)])*\\)|<[0-9A-Fa-f\\s]*>)`, "g");
  const all = [...text.matchAll(re)];
  return pdfString(all.at(-1)?.[1]);
}

/**
 * PDF 1.5+ writers (most bank and office software) put the Info dictionary inside compressed
 * object streams, so the raw bytes alone do not show /Producer or the dates. Inflate the
 * Flate-compressed object streams and the XMP metadata stream and append their text.
 */
function pdfSearchText(bytes: Uint8Array, raw: string): string {
  const parts = [raw];
  let budget = 20 * 1024 * 1024; // cap on inflated bytes (zip-bomb guard)
  const re = /<<([^]*?)>>\s*stream\r?\n/g;
  for (let m = re.exec(raw), n = 0; m && n < 500 && budget > 0; m = re.exec(raw), n++) {
    const dict = m[1]!;
    if (!/\/FlateDecode/.test(dict) || !/\/Type\s*\/(ObjStm|Metadata)/.test(dict)) continue;
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) continue;
    try {
      const out = inflateSync(bytes.subarray(start, end), { maxOutputLength: Math.min(budget, 5 * 1024 * 1024) });
      budget -= out.length;
      parts.push(new TextDecoder("latin1").decode(out));
    } catch {
      // damaged or non-standard stream: ignore, raw scan still applies
    }
  }
  return parts.join("\n");
}

/** Technical file metadata used by the Risk & Fraud agent. Never contains document content. */
export function extractFileMetadata(bytes: Uint8Array, contentType: string): FileMetadata {
  const raw = new TextDecoder("latin1").decode(bytes);
  if (contentType === "application/pdf") {
    const text = pdfSearchText(bytes, raw);
    const xmpTool = text.match(/<xmp:CreatorTool>([^<]*)<\/xmp:CreatorTool>/)?.[1];
    const eofs = raw.match(/%%EOF/g)?.length ?? 1;
    // linearised PDFs legitimately contain two %%EOF markers
    const linearized = /\/Linearized\s/.test(raw.slice(0, 2048));
    return {
      producer: pdfInfo(text, "Producer"),
      creator: pdfInfo(text, "Creator") ?? xmpTool,
      creationDate: pdfDate(pdfInfo(text, "CreationDate")),
      modDate: pdfDate(pdfInfo(text, "ModDate")),
      incrementalUpdates: Math.max(0, eofs - (linearized ? 2 : 1)),
    };
  }
  const text = raw;
  if (contentType === "image/png") {
    // tEXt / iTXt chunks with the "Software" keyword
    const m = text.match(/(?:tEXt|iTXt)Software\x00(?:\x00\x00[^\x00]*\x00[^\x00]*\x00)?([^\x00]{1,200})/);
    return { software: m?.[1] };
  }
  if (contentType === "image/jpeg") {
    const head = text.slice(0, 65536);
    const m = head.match(/(Adobe Photoshop[^\x00]{0,40}|GIMP[^\x00]{0,20}|Canva|Pixelmator[^\x00]{0,20}|paint\.net[^\x00]{0,20})/);
    return { software: m?.[1] };
  }
  return {};
}

export const ALLOWED_TYPES = new Map([
  ["application/pdf", "pdf"],
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/tiff", "tiff"],
]);

/** Sniff the real type from magic bytes — the declared content type is not trusted. */
export function sniffType(b: Uint8Array): string | undefined {
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) return "image/tiff";
  return undefined;
}
