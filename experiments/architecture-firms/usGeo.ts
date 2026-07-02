/**
 * Heuristic US-location classifier for the architecture-firms tracker.
 *
 * Returns "us" | "foreign" | "unknown" for a free-text location string. Built for
 * the location formats these firms' ATSes actually emit:
 *   - Workday:        "Boston, MA, US"  /  "2 Locations"  (multi-location placeholder)
 *   - SmartRecruiters: "City, Region, us" / "City, Region, ro"  (lowercase ISO-3166 a2)
 *   - Oracle/UltiPro: "City, ST, Country" / "City, ST, US"
 *   - custom sites:   "Charlotte" / "New York" (bare city, no state) or "" (empty)
 *
 * No LLM: these strings are short and structured, so three lookup lists + a little
 * ordering logic classify essentially everything that carries a location at all.
 * Empty / placeholder strings return "unknown" (a data-capture gap, not a call we
 * can make from the string).
 */

export type GeoClass = "us" | "foreign" | "unknown";

const STATE_CODES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS",
  "KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY",
  "NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV",
  "WI","WY","DC","PR","GU","VI",
]);

const STATE_NAMES = new Set([
  "alabama","alaska","arizona","arkansas","california","colorado","connecticut",
  "delaware","florida","georgia","hawaii","idaho","illinois","indiana","iowa",
  "kansas","kentucky","louisiana","maine","maryland","massachusetts","michigan",
  "minnesota","mississippi","missouri","montana","nebraska","nevada",
  "new hampshire","new jersey","new mexico","new york","north carolina",
  "north dakota","ohio","oklahoma","oregon","pennsylvania","rhode island",
  "south carolina","south dakota","tennessee","texas","utah","vermont","virginia",
  "washington","west virginia","wisconsin","wyoming","district of columbia",
  "puerto rico",
]);

// ~210 of the largest / most architecturally active US cities. Used only as a
// last resort for bare "City" strings with no state/country qualifier.
const US_CITIES = new Set([
  "new york","los angeles","chicago","houston","phoenix","philadelphia",
  "san antonio","san diego","dallas","san jose","austin","jacksonville",
  "fort worth","columbus","charlotte","san francisco","indianapolis","seattle",
  "denver","washington","boston","el paso","nashville","detroit","oklahoma city",
  "portland","las vegas","memphis","louisville","baltimore","milwaukee",
  "albuquerque","tucson","fresno","sacramento","kansas city","mesa","atlanta",
  "omaha","colorado springs","raleigh","miami","long beach","virginia beach",
  "oakland","minneapolis","tulsa","tampa","arlington","new orleans","wichita",
  "cleveland","bakersfield","aurora","anaheim","honolulu","santa ana","riverside",
  "corpus christi","lexington","henderson","stockton","saint paul","st. paul",
  "st paul","cincinnati","saint louis","st. louis","st louis","pittsburgh",
  "greensboro","lincoln","anchorage","plano","orlando","irvine","newark","durham",
  "chula vista","toledo","fort wayne","st. petersburg","st petersburg","laredo",
  "jersey city","chandler","madison","lubbock","scottsdale","reno","buffalo",
  "gilbert","glendale","winston-salem","chesapeake","norfolk","fremont","garland",
  "irving","hialeah","richmond","boise","spokane","baton rouge","tacoma",
  "san bernardino","modesto","fontana","des moines","moreno valley",
  "santa clarita","fayetteville","oxnard","rochester","port st. lucie",
  "grand rapids","huntsville","salt lake city","frisco","yonkers","amarillo",
  "huntington beach","mckinney","montgomery","augusta","akron","little rock",
  "tempe","overland park","grand prairie","tallahassee","cape coral","mobile",
  "knoxville","shreveport","worcester","sioux falls","chattanooga","brownsville",
  "fort lauderdale","providence","newport news","rancho cucamonga","santa rosa",
  "peoria","oceanside","elk grove","salem","pembroke pines","eugene",
  "garden grove","cary","fort collins","corona","springfield","jackson",
  "alexandria","hayward","clarksville","lakewood","lancaster","salinas",
  "palmdale","hollywood","pasadena","sunnyvale","macon","pomona","escondido",
  "killeen","naperville","joliet","bellevue","savannah","paterson","torrance",
  "bridgeport","mcallen","mesquite","syracuse","midland","murfreesboro","miramar",
  "dayton","fullerton","olathe","orange","thornton","roseville","denton","waco",
  "carrollton","charleston","warren","hampton","gainesville","visalia",
  "coral springs","columbia","cedar rapids","sterling heights","new haven",
  "stamford","concord","kent","santa clara","elizabeth","round rock","ann arbor",
  "tyler","palo alto","berkeley","cambridge","princeton","newport beach",
  "costa mesa","san mateo","culver city","santa monica","bethesda","arlington",
  "stamford","white plains",
]);

// Country names + selected major foreign cities, for positively tagging non-US.
const FOREIGN = new Set([
  // countries
  "united kingdom","uk","england","scotland","wales","canada","australia",
  "germany","france","china","india","japan","singapore","thailand","vietnam",
  "indonesia","malaysia","philippines","south korea","korea","mexico","brazil",
  "spain","italy","netherlands","belgium","switzerland","austria","poland",
  "sweden","norway","denmark","finland","ireland","portugal","greece","turkey",
  "israel","saudi arabia","united arab emirates","uae","qatar","kuwait","bahrain",
  "oman","egypt","morocco","south africa","nigeria","kenya","argentina","chile",
  "colombia","peru","ecuador","dominican republic","costa rica","panama",
  "new zealand","hong kong","taiwan","czech republic","romania","hungary",
  "ukraine","russia",
  // common foreign cities seen bare in these feeds
  "london","toronto","vancouver","montreal","sydney","melbourne","tokyo",
  "shanghai","beijing","shenzhen","hong kong","bangkok","mumbai","bangalore",
  "bengaluru","gurugram","gurgaon","noida","pune","delhi","new delhi","munich",
  "berlin","paris","madrid","barcelona","amsterdam","dubai","abu dhabi","doha",
  "riyadh","singapore","seoul","mexico city","sao paulo","santo domingo",
  "bucharest","copenhagen","malmo","manchester","birmingham, uk",
]);

// Lowercase ISO-3166 alpha-2 codes appear as the trailing token in SmartRecruiters
// feeds ("City, Region, ro"). "us" is the only one we treat as US.
const NON_US_ISO2 = /^(?!us$)[a-z]{2}$/;

function parts(loc: string): string[] {
  return loc.split(",").map((p) => p.trim()).filter(Boolean);
}

export function classifyLocation(rawLocation: string): GeoClass {
  const loc = (rawLocation ?? "").trim();
  if (!loc) return "unknown";

  // Workday multi-location placeholder ("2 Locations", "11 Locations").
  if (/^\d+\s+locations?$/i.test(loc)) return "unknown";

  const lower = loc.toLowerCase();
  const segs = parts(loc);
  const tail = segs[segs.length - 1] ?? "";
  const tailLower = tail.toLowerCase();

  // 1) Explicit US country marker wins (incl. lowercase ISO "us").
  if (/\bunited states\b|\busa\b/i.test(loc)) return "us";
  if (tailLower === "us" || tailLower === "u.s." || tailLower === "u.s.a.") return "us";

  // 2) Lowercase ISO-3166 a2 trailing token that isn't "us" => foreign.
  if (NON_US_ISO2.test(tailLower)) return "foreign";

  // 3) Any segment that names a foreign country / known foreign city => foreign.
  for (const seg of segs) {
    if (FOREIGN.has(seg.toLowerCase())) return "foreign";
  }
  if (FOREIGN.has(lower)) return "foreign";

  // 4) US state code (uppercase, e.g. "Boston, MA") or full state name => US.
  for (const seg of segs) {
    if (STATE_CODES.has(seg.toUpperCase()) && seg.length === 2) return "us";
    if (STATE_NAMES.has(seg.toLowerCase())) return "us";
  }

  // 5) Bare US city (no state/country qualifier).
  for (const seg of segs) {
    if (US_CITIES.has(seg.toLowerCase())) return "us";
  }
  if (US_CITIES.has(lower)) return "us";

  return "unknown";
}
