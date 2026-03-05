export type ATS =
  | "greenhouse"
  | "workday"
  | "lever"
  | "smartrecruiters"
  | "icims"
  | "ashby"
  | "phenom"
  | "amazon"
  | "generic";

export interface RawJob {
  title?: string | null;
  url?: string | null;
  location?: string | null;
  company?: string | null;
  ats?: ATS;
  source?: string;
}

export interface NormalizedJob {
  title: string;
  url: string;
  location: string;
  ats: ATS;
  company: string;
  source: string;
}

export interface TenantInfo {
  tenant: string | null;
  metadata: Record<string, string>;
  endpoints: string[];
}

export interface ExtractContext {
  sourceUrl: string;
  finalUrl: string;
  html: string;
  ats: ATS;
  tenantInfo: TenantInfo;
}

export interface ScrapeResult {
  source: string;
  ats: ATS;
  tenant: string | null;
  jobs_count: number;
  creative_jobs: NormalizedJob[];
}

export type JobTypeValue = "GIG" | "FULLTIME" | "PARTTIME" | "FREELANCE";
export type WorkTypeValue = "ONSITE" | "HYBRID" | "REMOTE";
export type SalaryPeriodValue =
  | "HOURLY"
  | "DAILY"
  | "WEEKLY"
  | "MONTHLY"
  | "ANNUAL"
  | "ONE_TIME";

export interface ApiLocation {
  placeId: string;
  name: string;
  formattedAddress: string;
  latitude: number;
  longitude: number;
  city: string;
  state: string;
  country: string;
}

export interface ApiCompany {
  name?: string | null;
  website?: string | null;
  logo?: string | null;
  email?: string | null;
}

export interface ApiSalary {
  min: number | null;
  max: number | null;
  currency: string;
  period: SalaryPeriodValue | null;
}

export interface ApiCreateJobRequest {
  title: string;
  description: string;
  deadline?: string | null;
  keywords?: string[] | null;
  skills?: string[] | null;
  jobType: JobTypeValue;
  location?: ApiLocation | null;
  salary?: ApiSalary | null;
  company?: ApiCompany | null;
  jobLink?: string | null;
  hiringTeam: string[];
  workEmail?: string | null;
  numberOfPositions?: number | null;
  workType?: WorkTypeValue | null;
  screeningQuestions?: unknown[] | null;
  screeningRequired?: boolean;
  allowEmailApplications?: boolean;
}

export interface EnrichedJobRecord {
  apiJob: ApiCreateJobRequest;
  sourceUrl: string;
  sourceCareerPage: string;
  ats: ATS;
  creativeScore: number;
  extractedAt: string;
}
