/**
 * Fixture-based sample test: 20 jobs through buildJobFromHeuristics.
 * No network needed. Verifies workEmail, allowEmailApplications, skills, keywords.
 *
 * Usage: node node_modules/tsx/dist/cli.mjs pipeline/sampleTest.ts
 */

import { mkdir, writeFile } from "node:fs/promises";
import { buildJobFromHeuristics, toCsvRows } from "./enrichFromCsv.js";

// ─── Helpers ─────────────────────────────────────────────────────

function jobHtml(opts: {
  title?: string;
  description?: string;
  email?: string;
  salary?: string;
  location?: string;
  skills?: string;
}): string {
  return `<!DOCTYPE html><html><head><title>${opts.title ?? "Job"}</title></head><body>
    <h1>${opts.title ?? "Job"}</h1>
    <div class="job-description">
      ${opts.description ?? "We are hiring a talented professional."}
      ${opts.skills ? `<p>Required skills: ${opts.skills}</p>` : ""}
      ${opts.salary ? `<p>Salary: ${opts.salary}</p>` : ""}
      ${opts.location ? `<p>Location: ${opts.location}</p>` : ""}
      ${opts.email ? `<p>Apply: <a href="mailto:${opts.email}">${opts.email}</a></p>` : ""}
    </div>
  </body></html>`;
}

function jsonLdStr(data: Record<string, unknown>): string {
  return `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
}

function withJsonLd(html: string, data: Record<string, unknown>): string {
  return html.replace("</head>", `${jsonLdStr(data)}</head>`);
}

// ─── 20 Fixtures ─────────────────────────────────────────────────

const BASE_UID = "test-scraper";

interface Fixture {
  url: string;
  seedTitle: string;
  html: string;
  jsonLd: Record<string, unknown> | null;
}

const fixtures: Fixture[] = [
  // 1. Plain job with work email (no JSON-LD)
  {
    url: "https://studio.io/careers/designer",
    seedTitle: "Product Designer",
    html: jobHtml({ title: "Product Designer", email: "jobs@studio.io", skills: "Figma, Sketch, Prototyping", description: "We seek a skilled product designer with experience in user research and design systems." }),
    jsonLd: null,
  },
  // 2. Job with JSON-LD + salary + location
  {
    url: "https://example.com/jobs/ux-lead",
    seedTitle: "UX Lead",
    html: withJsonLd(jobHtml({ title: "UX Lead", email: "hr@example.com", skills: "Figma, UX Research", description: "Lead our UX team building beautiful interfaces." }), {
      "@type": "JobPosting",
      title: "UX Lead",
      description: "Lead our UX team building beautiful interfaces.",
      baseSalary: { "@type": "MonetaryAmount", currency: "USD", value: { "@type": "QuantitativeValue", minValue: 100000, maxValue: 140000, unitText: "YEAR" } },
      jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: "New York", addressRegion: "NY", addressCountry: "US" } },
    }),
    jsonLd: {
      "@type": "JobPosting",
      title: "UX Lead",
      description: "Lead our UX team building beautiful interfaces.",
      baseSalary: { "@type": "MonetaryAmount", currency: "USD", value: { "@type": "QuantitativeValue", minValue: 100000, maxValue: 140000, unitText: "YEAR" } },
      jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: "New York", addressRegion: "NY", addressCountry: "US" } },
    },
  },
  // 3. Remote job, no email
  {
    url: "https://agency.co/jobs/motion",
    seedTitle: "Motion Designer",
    html: jobHtml({ title: "Motion Designer", skills: "After Effects, Premiere, Cinema 4D", description: "Create compelling motion graphics for our clients. 100% remote position." }),
    jsonLd: null,
  },
  // 4. JSON-LD with skills + keywords
  {
    url: "https://techcorp.com/careers/frontend",
    seedTitle: "Frontend Engineer",
    html: withJsonLd(jobHtml({ title: "Frontend Engineer", skills: "React, TypeScript, CSS", description: "Build scalable frontend applications using modern frameworks." }), {
      "@type": "JobPosting",
      title: "Frontend Engineer",
      skills: "React, TypeScript, CSS, GraphQL",
      keywords: "frontend, web development, SPA",
    }),
    jsonLd: { "@type": "JobPosting", title: "Frontend Engineer", skills: "React, TypeScript, CSS, GraphQL", keywords: "frontend, web development, SPA" },
  },
  // 5. Email in body text only (not mailto link)
  {
    url: "https://boutique.agency/apply/creative-director",
    seedTitle: "Creative Director",
    html: jobHtml({ title: "Creative Director", description: "Lead our creative studio. Send CV to creative@boutique.agency for consideration.", skills: "Branding, Art Direction, Copywriting" }),
    jsonLd: null,
  },
  // 6. Job with salary text in description
  {
    url: "https://startup.io/jobs/brand-designer",
    seedTitle: "Brand Designer",
    html: jobHtml({ title: "Brand Designer", email: "apply@startup.io", salary: "$80,000 - $100,000 per year", skills: "Illustrator, Branding, Visual Design", description: "Shape the visual identity of our growing startup. Compensation $80,000 - $100,000 per year." }),
    jsonLd: null,
  },
  // 7. Contract job
  {
    url: "https://freelance.net/gig/illustrator",
    seedTitle: "Illustrator",
    html: jobHtml({ title: "Illustrator (Contract)", email: "gigs@freelance.net", description: "6-month contract illustrator role for editorial and marketing work.", skills: "Illustration, Procreate, Photoshop" }),
    jsonLd: null,
  },
  // 8. Hybrid work type
  {
    url: "https://media.com/jobs/content-strategist",
    seedTitle: "Content Strategist",
    html: jobHtml({ title: "Content Strategist", description: "Hybrid role (3 days onsite in Austin, TX). Drive our content strategy across channels.", skills: "SEO, Content Writing, Analytics" }),
    jsonLd: null,
  },
  // 9. JSON-LD with validThrough deadline + company
  {
    url: "https://agency.com/jobs/vp-design",
    seedTitle: "VP of Design",
    html: withJsonLd(jobHtml({ title: "VP of Design", email: "talent@agency.com", description: "Lead design across product, brand, and marketing." }), {
      "@type": "JobPosting",
      title: "VP of Design",
      validThrough: "2026-04-30",
      employmentType: "FULL_TIME",
      hiringOrganization: { "@type": "Organization", name: "Agency Inc", url: "https://agency.com" },
    }),
    jsonLd: { "@type": "JobPosting", title: "VP of Design", validThrough: "2026-04-30", employmentType: "FULL_TIME", hiringOrganization: { "@type": "Organization", name: "Agency Inc", url: "https://agency.com" } },
  },
  // 10. Part-time role with location
  {
    url: "https://university.edu/jobs/adjunct",
    seedTitle: "Adjunct Instructor - Graphic Design",
    html: jobHtml({ title: "Adjunct Instructor - Graphic Design", email: "faculty@university.edu", description: "Part-time adjunct instructor for graphic design courses. MFA required.", location: "Chicago, IL", skills: "Teaching, Graphic Design, Typography" }),
    jsonLd: null,
  },
  // 11. No email, no JSON-LD
  {
    url: "https://bigco.com/careers/design-systems",
    seedTitle: "Design Systems Engineer",
    html: jobHtml({ title: "Design Systems Engineer", description: "Build and maintain our design system used by 200+ engineers.", skills: "Design Tokens, Storybook, React" }),
    jsonLd: null,
  },
  // 12. Company email via JSON-LD, no work email in HTML
  {
    url: "https://studio.design/jobs/pm",
    seedTitle: "Product Manager",
    html: jobHtml({ title: "Product Manager", description: "Own the product roadmap for our core design tool." }),
    jsonLd: { "@type": "JobPosting", title: "Product Manager", hiringOrganization: { "@type": "Organization", name: "Studio Design", url: "https://studio.design", email: "contact@studio.design" } },
  },
  // 13. Long description — simulates the problematic "row 13" pattern
  {
    url: "https://university.edu/jobs/art-design-lecturer",
    seedTitle: "Department of Art & Design, Art History - Part Time Lecturer",
    html: `<!DOCTYPE html><html><head><title>Part Time Lecturer Pool</title></head><body>
      <h1>Department of Art &amp; Design, Art History, Art Education — Part Time Lecturer Pool</h1>
      <div class="description">
        <p>The Department of Art &amp; Design invites applications for a part-time lecturer pool.</p>
        <p>Responsibilities: ${Array(50).fill("Teach undergraduate art courses.").join(" ")}</p>
        <p>Required skills: Drawing, Painting, Art History, Sculpture, Photography</p>
        <p>Location: San Bernardino, CA</p>
        <p>Contact: kgray@csusb.edu</p>
      </div>
    </body></html>`,
    jsonLd: null,
  },
  // 14. Senior role with equity mention
  {
    url: "https://techstartup.com/jobs/senior-engineer",
    seedTitle: "Senior Software Engineer",
    html: jobHtml({ title: "Senior Software Engineer", email: "recruiting@techstartup.com", salary: "$150,000 - $200,000 + equity", skills: "Python, Kubernetes, AWS", description: "Join our platform engineering team building scalable infrastructure." }),
    jsonLd: null,
  },
  // 15. ATS-style minimal page — should fall back to placeholder
  {
    url: "https://jobs.lever.co/company/abc123",
    seedTitle: "UI Designer",
    html: `<html><head><title>UI Designer at Acme</title></head><body><div id="content">Apply now</div></body></html>`,
    jsonLd: null,
  },
  // 16. Multiple emails — should pick the work one
  {
    url: "https://creative.studio/jobs/animator",
    seedTitle: "Animator",
    html: jobHtml({ title: "Animator", email: "apply@creative.studio", description: "Create 2D and 3D animations. Do not contact privacy@gdpr-example.com.", skills: "After Effects, Blender, Maya" }),
    jsonLd: null,
  },
  // 17. JSON-LD with TELECOMMUTE flag
  {
    url: "https://remoteagency.com/jobs/copywriter",
    seedTitle: "Copywriter",
    html: withJsonLd(jobHtml({ title: "Copywriter", email: "jobs@remoteagency.com", description: "Write compelling copy for digital campaigns.", skills: "Copywriting, SEO Writing" }), {
      "@type": "JobPosting",
      title: "Copywriter",
      jobLocationType: "TELECOMMUTE",
      employmentType: "FULL_TIME",
    }),
    jsonLd: { "@type": "JobPosting", title: "Copywriter", jobLocationType: "TELECOMMUTE", employmentType: "FULL_TIME" },
  },
  // 18. Internship with hourly salary
  {
    url: "https://designfirm.io/internships/summer",
    seedTitle: "Design Intern",
    html: jobHtml({ title: "Design Intern (Summer 2026)", email: "internships@designfirm.io", description: "10-week summer internship for design students. Paid position.", salary: "$25/hr", skills: "Figma, Adobe Creative Suite" }),
    jsonLd: null,
  },
  // 19. Privacy email only — should NOT trigger allowEmailApplications
  {
    url: "https://nonprofit.org/careers/art-director",
    seedTitle: "Art Director",
    html: jobHtml({ title: "Art Director", description: "Lead our visual communications team. For privacy inquiries: privacy@nonprofit.org", skills: "Art Direction, Print Design, Branding" }),
    jsonLd: null,
  },
  // 20. Full JSON-LD: all fields
  {
    url: "https://enterprise.com/jobs/design-ops",
    seedTitle: "Design Ops Manager",
    html: withJsonLd(jobHtml({ title: "Design Ops Manager", email: "design.ops@enterprise.com", description: "Scale design operations across 15 product teams.", skills: "Design Systems, Process, Jira, Figma" }), {
      "@type": "JobPosting",
      title: "Design Ops Manager",
      description: "Scale design operations across 15 product teams.",
      skills: "Design Systems, Process Improvement, Figma",
      keywords: "design ops, operations, systems",
      baseSalary: { "@type": "MonetaryAmount", currency: "USD", value: { "@type": "QuantitativeValue", minValue: 120000, maxValue: 160000, unitText: "YEAR" } },
      jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: "San Francisco", addressRegion: "CA", addressCountry: "US" } },
      validThrough: "2026-05-01",
      employmentType: "FULL_TIME",
      hiringOrganization: { "@type": "Organization", name: "Enterprise Co", url: "https://enterprise.com" },
    }),
    jsonLd: {
      "@type": "JobPosting",
      title: "Design Ops Manager",
      description: "Scale design operations across 15 product teams.",
      skills: "Design Systems, Process Improvement, Figma",
      keywords: "design ops, operations, systems",
      baseSalary: { "@type": "MonetaryAmount", currency: "USD", value: { "@type": "QuantitativeValue", minValue: 120000, maxValue: 160000, unitText: "YEAR" } },
      jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: "San Francisco", addressRegion: "CA", addressCountry: "US" } },
      validThrough: "2026-05-01",
      employmentType: "FULL_TIME",
      hiringOrganization: { "@type": "Organization", name: "Enterprise Co", url: "https://enterprise.com" },
    },
  },
];

// ─── Run ─────────────────────────────────────────────────────────

const jobs = fixtures.map(f =>
  buildJobFromHeuristics(f.html, f.url, f.seedTitle, f.jsonLd, BASE_UID),
);

// ─── Verify ──────────────────────────────────────────────────────

interface Check { row: number; field: string; expected: string; actual: string; pass: boolean }
const checks: Check[] = [];
let failCount = 0;

function check(row: number, field: string, expected: string, actual: string) {
  const pass = expected === "any" ? actual.length > 0 : (actual === expected || actual.includes(expected));
  checks.push({ row, field, expected, actual, pass });
  if (!pass) failCount++;
}

console.log("\n══════════════════════════════════════════════════════════");
console.log("  20-job sample — buildJobFromHeuristics verification");
console.log("══════════════════════════════════════════════════════════\n");

jobs.forEach((job, i) => {
  const row = i + 1;
  console.log(`Row ${String(row).padStart(2, "0")}: ${job.title}`);
  console.log(`       email=${job.workEmail ?? "(none)"}  allowEmail=${job.allowEmailApplications}  workType=${job.workType ?? "?"}`);
  console.log(`       skills=[${(job.skills ?? []).slice(0, 4).join(", ")}]`);
  console.log(`       keywords=[${(job.keywords ?? []).slice(0, 4).join(", ")}]`);
  if (job.salary?.min != null) console.log(`       salary=${job.salary.min}-${job.salary.max} ${job.salary.currency} ${job.salary.period}`);
  if (job.company?.name) console.log(`       company=${job.company.name}  companyEmail=${job.company.email ?? "(none)"}`);
  if (job.deadline) console.log(`       deadline=${job.deadline}`);
  console.log();
});

// Assertions
check(1,  "workEmail",             "jobs@studio.io",           jobs[0].workEmail ?? "");
check(1,  "allowEmailApplications","true",                     String(jobs[0].allowEmailApplications));
check(1,  "skills",                "any",                      (jobs[0].skills ?? []).join(","));
check(2,  "salary.min",            "100000",                   String(jobs[1].salary?.min ?? ""));
check(2,  "salary.currency",       "USD",                      jobs[1].salary?.currency ?? "");
check(2,  "location.city",         "New York",                 jobs[1].location?.city ?? "");
check(2,  "workEmail",             "hr@example.com",           jobs[1].workEmail ?? "");
check(2,  "allowEmailApplications","true",                     String(jobs[1].allowEmailApplications));
check(3,  "workType",              "REMOTE",                   jobs[2].workType ?? "");
check(3,  "allowEmailApplications","false",                    String(jobs[2].allowEmailApplications));
check(4,  "skills",                "any",                      (jobs[3].skills ?? []).join(","));
check(4,  "keywords",              "any",                      (jobs[3].keywords ?? []).join(","));
check(5,  "workEmail",             "creative@boutique.agency", jobs[4].workEmail ?? "");
check(5,  "allowEmailApplications","true",                     String(jobs[4].allowEmailApplications));
check(6,  "allowEmailApplications","true",                     String(jobs[5].allowEmailApplications));
check(7,  "workEmail",             "gigs@freelance.net",       jobs[6].workEmail ?? "");
check(9,  "deadline",              "2026-04-30",               jobs[8].deadline ?? "");
check(9,  "company.name",          "Agency Inc",               jobs[8].company?.name ?? "");
check(13, "workEmail",             "kgray@csusb.edu",          jobs[12].workEmail ?? "");
check(13, "allowEmailApplications","true",                     String(jobs[12].allowEmailApplications));
check(13, "skills",                "any",                      (jobs[12].skills ?? []).join(","));
check(17, "workType",              "REMOTE",                   jobs[16].workType ?? "");
check(19, "allowEmailApplications","false",                    String(jobs[18].allowEmailApplications));
check(20, "salary.min",            "120000",                   String(jobs[19].salary?.min ?? ""));
check(20, "company.email",         "design.ops@enterprise.com",jobs[19].company?.email ?? "");
check(20, "allowEmailApplications","true",                     String(jobs[19].allowEmailApplications));

console.log("══════════════════════════════════════════════════════════");
console.log("Verification checks:");
console.log("══════════════════════════════════════════════════════════");
for (const c of checks) {
  const icon = c.pass ? "✓" : "✗";
  const label = `Row ${String(c.row).padStart(2)}.${c.field}`.padEnd(40);
  if (c.pass) {
    console.log(`  ${icon} ${label}`);
  } else {
    console.log(`  ${icon} ${label}  expected=${c.expected}  got=${c.actual || "(empty)"}`);
  }
}

const total = checks.length;
console.log(`\n${failCount === 0 ? "All" : failCount + " of"} ${total} checks ${failCount === 0 ? "passed ✓" : "FAILED ✗"}`);

// Write CSV
await mkdir("outputs/sample20", { recursive: true });
const csvPath = "outputs/sample20/results_jobs_sample20.csv";
await writeFile(csvPath, toCsvRows(jobs), "utf8");
console.log(`\nCSV written → ${csvPath}\n`);
