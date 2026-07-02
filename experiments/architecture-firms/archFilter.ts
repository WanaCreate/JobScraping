/**
 * Architecture-role filter.
 *
 * The firm list is dominated by building-architecture practices, but several
 * (AECOM, Jacobs, WSP, Arcadis, Stantec, HOK) are large multidisciplinary firms
 * that also post IT roles like "Solutions Architect" or "Data Architect". Those
 * are NOT what we want, so we explicitly exclude the tech-architect family.
 */

// Titles to EXCLUDE even though they contain "architect" or "designer" — these are
// software / non-building-design roles, not building architecture.
const EXCLUDE = new RegExp(
  [
    // IT/software "X architect"
    "\\b(solutions?|software|data|cloud|enterprise|systems?|security|information|",
    "network|technical|integration|infrastructure|devops|platform|application|",
    "java|\\.net|aws|azure|gcp|salesforce|sap|sharepoint|api|ml|ai)\\s+architect",
    // non-architecture creative/digital "X designer"
    "|\\b(graphic|ux|ui|ux/ui|web|product|game|motion|industrial|fashion|",
    "instructional|experience|visual|brand|content|sound|audio|3d|cad)\\s+designer",
    // engineering-discipline "X designer" (common at AECOM/STV/Stantec/WSP/HDR)
    "|\\b(plumbing|electrical|mechanical|civil|structural|highway|roadway|drainage|",
    "traffic|hydraulic|geotechnical|hvac|piping|transmission|wastewater|bridge|rail|",
    "transportation|gis|controls|instrumentation|substation|pipeline|utility|survey|",
    "process|telecom|water|fire protection)\\s+(designer|engineer)",
  ].join(""),
  "i"
);

// Building-architecture signals in a job title. Covers senior through entry-level:
// "Project Architect", "Architectural Designer", "Junior Designer", "Entry-Level
// Architect", "Graduate Architect", "Design Intern", "Job Captain", BIM/Revit.
// NOTE: leading word-boundary only on "architect"/"designer" — some crawled titles
// jam the location/department onto the title with no space
// ("Project ArchitectCharleston", "Junior DesignerNew York"), so we must still match
// when the keyword is immediately followed by other letters.
const ARCH_INCLUDE = new RegExp(
  [
    "\\barchitect",              // Architect(s), Architectural, Architecture, Project Architect
    "|\\bdesigner",              // (Junior/Senior/Architectural/Interior) Designer
    "|\\bjob captain\\b",        // common arch-firm title for a project lead
    "|\\bdesign(er)? intern\\b", // Design Intern / Designer Intern
    "|\\bdesign internship\\b",
    "|\\bbim\\b",                // BIM Manager / Specialist / Coordinator
    "|\\brevit\\b",
  ].join(""),
  "i"
);

export interface ArchMatch {
  matched: boolean;
  reason: string;
}

export function classifyArchTitle(title: string | null | undefined): ArchMatch {
  const t = (title ?? "").trim();
  if (!t) return { matched: false, reason: "empty-title" };

  if (EXCLUDE.test(t)) {
    return { matched: false, reason: "excluded-non-arch" };
  }

  if (ARCH_INCLUDE.test(t)) {
    return { matched: true, reason: "arch-keyword" };
  }

  return { matched: false, reason: "no-arch-keyword" };
}

/** Search term to pass to ATSes that support server-side keyword search. */
export const ARCH_SEARCH_TERM = "architect";
