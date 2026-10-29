/**
 * SIMULATED Romanian authority sources (Biroul de Credit, CRC/BNR, ANAF, cazier judiciar,
 * ANCPI land register, the bank's KYC store, a PEP list). The bank has no live access to these yet.
 *
 * Every result carries `simulated: true`, which flows into findings ("SIMULAT"), the UI and the
 * audit record. `assertSimulationAllowed` refuses to construct these in production.
 */
import type {
  AnafPort,
  AuthorityResult,
  CentralCreditRegisterPort,
  CreditBureauPort,
  CreditReport,
  CriminalRecord,
  CriminalRecordPort,
  KycRecord,
  KycStorePort,
  LandRegisterPort,
  LandRegisterRecord,
  ListStatus,
  SanctionsListPort,
  SanctionsMatch,
  SanctionsQuery,
  TaxDebt,
} from "@dc/ports";
import { nameMatchScore as scoreName } from "@dc/rules";

export type Scenario = {
  creditBureau?: CreditReport | "unavailable";
  centralCreditRegister?: CreditReport | "unavailable";
  anaf?: TaxDebt | "unavailable";
  criminalRecord?: CriminalRecord | "unavailable";
};

export type ScenarioFile = {
  /** Keyed by CNP. Unknown CNPs get a clean record. */
  persons: Record<string, Scenario>;
  /** Keyed by cadastral number. Unknown numbers are "unavailable". */
  landRegister: Record<string, LandRegisterRecord>;
  /** Keyed by customerRef. Unknown customers have no prior KYC file. */
  kyc: Record<string, KycRecord>;
  pep: { name: string; birthDate?: string; position: string; country: string }[];
};

export function assertSimulationAllowed(env: Record<string, string | undefined> = process.env) {
  if (env.NODE_ENV === "production" && env.ALLOW_SIMULATED_AUTHORITIES !== "i-understand-this-is-not-real-data")
    throw new Error("Simulated authority adapters are disabled in production. Configure real authority connections.");
}

const meta = (source: string) => ({ source: `${source} (SIMULAT)`, simulated: true as const, retrievedAt: new Date().toISOString() });

function result<T>(source: string, v: T | "unavailable" | undefined, clean: T): AuthorityResult<T> {
  if (v === "unavailable") return { ...meta(source), status: "unavailable", reason: "Sursa simulată indisponibilă (scenariu)" };
  return { ...meta(source), status: "ok", data: v ?? clean };
}

const CLEAN_CREDIT: CreditReport = { records: [], insolvency: false, inquiriesLast6m: 0 };

export function createSimulatedAuthorities(file: ScenarioFile) {
  assertSimulationAllowed();
  const person = (cnp: string) => file.persons[cnp] ?? {};

  const creditBureau: CreditBureauPort = {
    report: async (cnp) => result("Biroul de Credit", person(cnp).creditBureau, CLEAN_CREDIT),
  };
  const centralCreditRegister: CentralCreditRegisterPort = {
    report: async (cnp) => result("Centrala Riscului de Credit (BNR)", person(cnp).centralCreditRegister, CLEAN_CREDIT),
  };
  const anaf: AnafPort = {
    taxDebt: async (cnp) => result("ANAF", person(cnp).anaf, { hasDebt: false, amountRon: 0, asOf: new Date().toISOString().slice(0, 10) }),
  };
  const criminalRecord: CriminalRecordPort = {
    lookup: async (cnp) => result("IGPR — Cazier judiciar", person(cnp).criminalRecord, { hasRecord: false, entries: [] }),
  };
  const landRegister: LandRegisterPort = {
    lookup: async (nr) => {
      const r = file.landRegister[nr];
      return r
        ? { ...meta("ANCPI eTerra"), status: "ok", data: r }
        : { ...meta("ANCPI eTerra"), status: "unavailable", reason: `Nu există înregistrare simulată pentru nr. cadastral ${nr}` };
    },
  };
  const kycStore: KycStorePort = {
    get: async (ref) => ({ ...meta("KYC bancă"), status: "ok", data: file.kyc[ref] ?? null }),
  };
  const pepList: SanctionsListPort = {
    listId: "pep",
    status: async (): Promise<ListStatus> => ({ listId: "pep", status: "ok", version: "simulated", fetchedAt: new Date().toISOString(), entries: file.pep.length, simulated: true }),
    search: async (q: SanctionsQuery): Promise<SanctionsMatch[]> =>
      file.pep
        .map((p, i) => ({ p, i, score: scoreName(q.fullName, p.name) }))
        .filter((x) => x.score >= 0.92 && (!q.birthDate || !x.p.birthDate || x.p.birthDate.slice(0, 4) === q.birthDate.slice(0, 4)))
        .map((x) => ({
          listId: "pep",
          entryId: `PEP-${x.i + 1}`,
          matchedName: x.p.name,
          score: x.score,
          birthDates: x.p.birthDate ? [x.p.birthDate] : [],
          citizenships: [x.p.country],
          programme: x.p.position,
        })),
  };

  return { creditBureau, centralCreditRegister, anaf, criminalRecord, landRegister, kycStore, pepList };
}

export async function loadScenarioFile(path: string): Promise<ScenarioFile> {
  const f = Bun.file(path);
  const raw = (await f.exists()) ? ((await f.json()) as Partial<ScenarioFile>) : {};
  return { persons: raw.persons ?? {}, landRegister: raw.landRegister ?? {}, kyc: raw.kyc ?? {}, pep: raw.pep ?? [] };
}
