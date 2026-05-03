// Minimal OSCAL types covering only the fields we use.
// See: https://pages.nist.gov/OSCAL/concepts/layer/control/catalog/

export interface OscalProp {
  name: string;
  ns?: string;
  value: string;
  class?: string;
}

export interface OscalLink {
  href: string;
  rel?: string;
  text?: string;
}

export interface OscalPart {
  id?: string;
  name: string;
  prose?: string;
  parts?: OscalPart[];
  props?: OscalProp[];
}

export interface OscalControl {
  id: string;
  class?: string;
  title: string;
  props?: OscalProp[];
  links?: OscalLink[];
  parts?: OscalPart[];
  controls?: OscalControl[];
}

export interface OscalGroup {
  id?: string;
  class?: string;
  title: string;
  props?: OscalProp[];
  parts?: OscalPart[];
  groups?: OscalGroup[];
  controls?: OscalControl[];
}

export interface OscalMetadata {
  title: string;
  version: string;
  "last-modified"?: string;
  "oscal-version"?: string;
  published?: string;
}

export interface OscalCatalog {
  uuid: string;
  metadata: OscalMetadata;
  groups?: OscalGroup[];
  controls?: OscalControl[];
  "back-matter"?: unknown;
}

export interface OscalCatalogDoc {
  catalog: OscalCatalog;
}

export interface OscalProfileDoc {
  profile: {
    uuid: string;
    metadata: OscalMetadata;
    imports?: unknown[];
    merge?: unknown;
    modify?: unknown;
  };
}

export type Applicability = "NC" | "OS" | "P" | "S" | "TS";
export const APPLICABILITY_LABELS: Record<Applicability, string> = {
  NC: "Non-classified",
  OS: "OFFICIAL: Sensitive",
  P: "PROTECTED",
  S: "SECRET",
  TS: "TOP SECRET",
};

export type ProfileName =
  | "ISM_NON_CLASSIFIED"
  | "ISM_OFFICIAL_SENSITIVE"
  | "ISM_PROTECTED"
  | "ISM_SECRET"
  | "ISM_TOP_SECRET"
  | "ISM_E8_ML1"
  | "ISM_E8_ML2"
  | "ISM_E8_ML3";

export const PROFILE_NAMES: ProfileName[] = [
  "ISM_NON_CLASSIFIED",
  "ISM_OFFICIAL_SENSITIVE",
  "ISM_PROTECTED",
  "ISM_SECRET",
  "ISM_TOP_SECRET",
  "ISM_E8_ML1",
  "ISM_E8_ML2",
  "ISM_E8_ML3",
];
