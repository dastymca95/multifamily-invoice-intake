/**
 * One-shot smoke for the multi-file property merge.
 *
 * Run with: npx tsx scripts/smoke-property-merge.ts
 *
 * Exercises the same code path the modal hits:
 *   1. Per-file mapping → applyMappingToSourceRows
 *   2. Cross-file merge → mergePropertyFiles
 * On synthetic inputs that mirror the real-world scenario the modal's
 * UI copy describes (a property-level file + a unit-level file).
 *
 * Not a formal test framework — prints PASS/FAIL per scenario and
 * exits non-zero on any FAIL so it can gate a CI step later if we add
 * one.
 */
import {
  applyMappingToSourceRows,
  mergePropertyFiles,
  type PropertyFileContribution,
  type PropertyUploadMapping,
  validatePropertyEntries,
} from "../src/types/property-catalog";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// =============================================================================
// Scenario 1 — property-level file + unit-level file
// =============================================================================
console.log("\n[scenario 1] property-level file A + unit-level file B");

const fileA_columns = [
  "Property Code",
  "Property Name",
  "Address",
  "City",
  "State",
  "Zip",
];
const fileA_rows: string[][] = [
  ["VST", "Vista Apartments", "100 Sunset Drive", "Austin", "TX", "78701"],
  ["OAK", "Oakwood Plaza", "250 Elm Street", "Houston", "TX", "77002"],
  ["MTC", "Mountain Crest", "400 Highland Way", "Denver", "CO", "80202"],
];
const fileA_mapping: PropertyUploadMapping = {
  property_code: "Property Code",
  property_name: "Property Name",
  property_abbreviation: null,
  address: "Address",
  city: "City",
  state: "State",
  zip: "Zip",
  unit_number: null,
  unit_type: null,
  building: null,
  active: null,
  notes: null,
};

const fileB_columns = ["Prop Code", "Unit No", "Unit Type", "Building", "Status"];
const fileB_rows: string[][] = [
  ["VST", "101", "1BR", "A", "Active"],
  ["VST", "102", "2BR", "A", "Active"],
  ["VST", "201", "1BR", "B", "Vacant"],
  ["OAK", "1A", "2BR", "Main", "Active"],
  ["OAK", "1B", "2BR", "Main", "Active"],
];
const fileB_mapping: PropertyUploadMapping = {
  property_code: "Prop Code",
  property_name: null,
  property_abbreviation: null,
  address: null,
  city: null,
  state: null,
  zip: null,
  unit_number: "Unit No",
  unit_type: "Unit Type",
  building: "Building",
  active: "Status",
  notes: null,
};

const aMapped = applyMappingToSourceRows(
  fileA_columns,
  fileA_rows,
  fileA_mapping,
);
const bMapped = applyMappingToSourceRows(
  fileB_columns,
  fileB_rows,
  fileB_mapping,
);

check(
  "file A applied: 3 entries, no blank-identity drops",
  aMapped.entries.length === 3 && aMapped.blankIdentityCount === 0,
  `got entries=${aMapped.entries.length} drops=${aMapped.blankIdentityCount}`,
);
check(
  "file B applied: 5 entries, no blank-identity drops",
  bMapped.entries.length === 5 && bMapped.blankIdentityCount === 0,
);
check(
  "file B leaves property_name blank when unmapped (deferred mirror)",
  bMapped.entries[0].property_name === "",
  `got name="${bMapped.entries[0].property_name}"`,
);
check(
  "file B keeps property_code populated",
  bMapped.entries[0].property_code === "VST",
);
check(
  "file B 'Vacant' → active=false",
  bMapped.entries[2].active === false,
  `got active=${bMapped.entries[2].active}`,
);

const contributions: PropertyFileContribution[] = [
  { filename: "property_list.csv", entries: aMapped.entries },
  { filename: "unit_roster.csv", entries: bMapped.entries },
];
const merged = mergePropertyFiles(contributions);

console.log("  merged stats:", merged.stats);
check(
  "merge consumed 8 source rows",
  merged.stats.totalSourceRows === 8,
);
// Expected final rows:
//   - VST/101, VST/102, VST/201 (unit rows for VST, donor absorbed)
//   - OAK/1A, OAK/1B (unit rows for OAK, donor absorbed)
//   - MTC (property-level — no unit rows, kept as standalone)
check(
  "merge produces 6 final canonical rows",
  merged.stats.finalRowCount === 6,
  `got finalRowCount=${merged.stats.finalRowCount}`,
);
check(
  "2 property-level donors absorbed (VST + OAK)",
  merged.stats.donorsAbsorbed === 2,
  `got donorsAbsorbed=${merged.stats.donorsAbsorbed}`,
);
check(
  "5 unit rows enriched with property-level fields",
  merged.stats.unitsEnrichedFromDonor === 5,
  `got unitsEnrichedFromDonor=${merged.stats.unitsEnrichedFromDonor}`,
);
check(
  "no duplicate (property, unit) pairs collapsed in this scenario",
  merged.stats.duplicatePairsMerged === 0,
);

// Spot-check the broadcast — the first VST unit row should now carry
// the address/city/state/zip + name from File A.
const vst101 = merged.entries.find(
  (e) => e.property_code === "VST" && e.unit_number === "101",
);
check(
  "VST/101 picked up name from donor",
  !!vst101 && vst101.property_name === "Vista Apartments",
  vst101 ? `got name=${vst101.property_name}` : "VST/101 missing",
);
check(
  "VST/101 picked up address from donor",
  !!vst101 && vst101.address === "100 Sunset Drive",
);
check(
  "VST/101 picked up city/state/zip from donor",
  !!vst101 &&
    vst101.city === "Austin" &&
    vst101.state === "TX" &&
    vst101.zip === "78701",
);

// MTC has no unit rows, so its property-level row should survive standalone.
const mtcStandalone = merged.entries.find(
  (e) => e.property_code === "MTC" && (e.unit_number == null || e.unit_number === ""),
);
check(
  "MTC standalone property row preserved (no units)",
  !!mtcStandalone && mtcStandalone.property_name === "Mountain Crest",
);

const v1 = validatePropertyEntries(merged.entries);
check(
  "merged entries pass required-field + unique-pair validation",
  v1.ok,
  `missingRequired=${v1.missingRequired} duplicatePairs=${v1.duplicatePairs}`,
);

// =============================================================================
// Scenario 2 — same property+unit appears in both files (cross-file dup)
// =============================================================================
console.log(
  "\n[scenario 2] same VST/101 in both files, file A wins for ties",
);

const dupA = applyMappingToSourceRows(
  ["Property Code", "Property Name", "Unit No", "City"],
  [["VST", "Vista Apartments", "101", "Austin"]],
  {
    property_code: "Property Code",
    property_name: "Property Name",
    property_abbreviation: null,
    address: null,
    city: "City",
    state: null,
    zip: null,
    unit_number: "Unit No",
    unit_type: null,
    building: null,
    active: null,
    notes: null,
  },
);
const dupB = applyMappingToSourceRows(
  ["Code", "Name", "Unit", "City", "Type"],
  [["VST", "Vista Apts (legacy)", "101", "Austin TX", "1BR"]],
  {
    property_code: "Code",
    property_name: "Name",
    property_abbreviation: null,
    address: null,
    city: "City",
    state: null,
    zip: null,
    unit_number: "Unit",
    unit_type: "Type",
    building: null,
    active: null,
    notes: null,
  },
);

const dupMerged = mergePropertyFiles([
  { filename: "a.csv", entries: dupA.entries },
  { filename: "b.csv", entries: dupB.entries },
]);

check(
  "single (VST, 101) bucket → 1 final row, 1 duplicate collapsed",
  dupMerged.stats.finalRowCount === 1 &&
    dupMerged.stats.duplicatePairsMerged === 1,
  `finalRowCount=${dupMerged.stats.finalRowCount} dups=${dupMerged.stats.duplicatePairsMerged}`,
);
check(
  "first-non-null wins → file A's name beats file B's",
  dupMerged.entries[0].property_name === "Vista Apartments",
  `got name=${dupMerged.entries[0].property_name}`,
);
check(
  "first-non-null wins → file A's city beats file B's",
  dupMerged.entries[0].city === "Austin",
);
check(
  "blank field on A filled from B → unit_type comes from B",
  dupMerged.entries[0].unit_type === "1BR",
);

// =============================================================================
// Scenario 3 — single-file passthrough
// =============================================================================
console.log("\n[scenario 3] one file, no merge work");

const single = mergePropertyFiles([
  { filename: "only.csv", entries: aMapped.entries },
]);
check(
  "single file: 3 in → 3 out, no donors absorbed (no units in this file)",
  single.stats.finalRowCount === 3 &&
    single.stats.donorsAbsorbed === 0 &&
    single.stats.unitsEnrichedFromDonor === 0,
  JSON.stringify(single.stats),
);

// =============================================================================
// Scenario 4 — empty contributions
// =============================================================================
console.log("\n[scenario 4] empty inputs");

const empty = mergePropertyFiles([]);
check(
  "empty contributions → empty result, all stats 0",
  empty.entries.length === 0 &&
    empty.stats.totalSourceRows === 0 &&
    empty.stats.finalRowCount === 0,
);

// =============================================================================
// Scenario 5a — single file with code only, no donor → fallback mirror
// =============================================================================
console.log(
  "\n[scenario 5a] single code-only file → final mirror gives valid entries",
);

const codeOnly = applyMappingToSourceRows(
  ["Property Number", "Unit", "Floorplan"],
  [
    ["VST", "101", "1BR"],
    ["VST", "102", "2BR"],
  ],
  {
    property_code: "Property Number",
    property_name: null,
    property_abbreviation: null,
    address: null,
    city: null,
    state: null,
    zip: null,
    unit_number: "Unit",
    unit_type: "Floorplan",
    building: null,
    active: null,
    notes: null,
  },
);
const codeOnlyMerged = mergePropertyFiles([
  { filename: "code_only.csv", entries: codeOnly.entries },
]);

check(
  "code-only single file: 2 final rows",
  codeOnlyMerged.entries.length === 2,
);
check(
  "fallback mirror: property_name = property_code when no donor",
  codeOnlyMerged.entries.every(
    (e) => e.property_name === e.property_code && e.property_name === "VST",
  ),
);
const v1a = validatePropertyEntries(codeOnlyMerged.entries);
check(
  "code-only merged passes save-time validation",
  v1a.ok,
  `missingRequired=${v1a.missingRequired} duplicatePairs=${v1a.duplicatePairs}`,
);

// =============================================================================
// Scenario 5 — required-field validation catches blank identity rows
// =============================================================================
console.log("\n[scenario 5] validation flags missing required + dup pairs");

const badEntries = [
  ...merged.entries,
  // synthesize a blank-required + a dup pair to confirm the validator catches them
  {
    id: "bad-1",
    property_code: "",
    property_name: "",
    property_abbreviation: null,
    address: null,
    city: null,
    state: null,
    zip: null,
    unit_number: null,
    unit_type: null,
    building: null,
    active: true,
    notes: null,
  },
  {
    id: "bad-2",
    property_code: "VST",
    property_name: "VST clone",
    property_abbreviation: null,
    address: null,
    city: null,
    state: null,
    zip: null,
    unit_number: "101", // duplicates VST/101 already in merged.entries
    unit_type: null,
    building: null,
    active: true,
    notes: null,
  },
];
const v2 = validatePropertyEntries(badEntries);
check(
  "validator flags 1 missing-required + 1 duplicate-pair",
  v2.ok === false && v2.missingRequired === 1 && v2.duplicatePairs === 1,
  JSON.stringify(v2),
);

// =============================================================================
// Scenario 6 — cross-file identity resolution (the headline Phase 13 fix)
//
// File A (Property List) carries both code AND name for VST.
// File B (flattened ResMan All Units) carries name + units only.
// Without the registry these would land in two parallel buckets
// ("vst" + "vista apartments") that don't merge. With the registry,
// File B's name-only rows resolve to the "vst" bucket.
// =============================================================================
console.log(
  "\n[scenario 6] cross-file identity: Property List (code+name) + All Units (name+units)",
);

const propListMapped = applyMappingToSourceRows(
  ["Property Code", "Property Name", "Address", "City"],
  [
    ["VST", "Vista Apartments", "100 Sunset Drive", "Austin"],
    ["OAK", "Oakwood Plaza", "250 Elm Street", "Houston"],
  ],
  {
    property_code: "Property Code",
    property_name: "Property Name",
    property_abbreviation: null,
    address: "Address",
    city: "City",
    state: null,
    zip: null,
    unit_number: null,
    unit_type: null,
    building: null,
    active: null,
    notes: null,
  },
);
// Simulates a flattened ResMan All Units file: synthesized
// "Property Name" column + Unit / Type / Status columns. NO property
// code anywhere in this file.
const allUnitsMapped = applyMappingToSourceRows(
  ["Property Name", "Unit", "Type", "Status"],
  [
    ["Vista Apartments", "101", "1BR", "Occupied"],
    ["Vista Apartments", "102", "2BR", "Vacant"],
    ["Vista Apartments", "203", "1BR", "Occupied"],
    ["Oakwood Plaza", "1A", "2BR", "Occupied"],
    ["Oakwood Plaza", "1B", "2BR", "Occupied"],
  ],
  {
    property_code: null,
    property_name: "Property Name",
    property_abbreviation: null,
    address: null,
    city: null,
    state: null,
    zip: null,
    unit_number: "Unit",
    unit_type: "Type",
    building: null,
    active: "Status",
    notes: null,
  },
);

const crossMerged = mergePropertyFiles([
  { filename: "property_list.csv", entries: propListMapped.entries },
  { filename: "all_units_flattened.csv", entries: allUnitsMapped.entries },
]);

console.log("  cross-merge stats:", crossMerged.stats);
check(
  "5 cross-file identity rewrites (one per name-only unit row)",
  crossMerged.stats.crossFileIdentitiesResolved === 5,
  `got crossFileIdentitiesResolved=${crossMerged.stats.crossFileIdentitiesResolved}`,
);
check(
  "5 final rows (3 VST units + 2 OAK units; donors absorbed)",
  crossMerged.stats.finalRowCount === 5,
  `got finalRowCount=${crossMerged.stats.finalRowCount}`,
);
check(
  "2 donors absorbed (Property List rows for VST + OAK)",
  crossMerged.stats.donorsAbsorbed === 2,
);
check(
  "5 units enriched with address/city from donor",
  crossMerged.stats.unitsEnrichedFromDonor === 5,
);

// Spot-check: VST/101 should have BOTH code AND name AND address now,
// even though no single source row carried all three.
const xVst101 = crossMerged.entries.find(
  (e) => e.unit_number === "101" && _norm(e.property_name) === "vista apartments",
);
check(
  "VST/101 picked up code 'VST' from Property List via registry",
  !!xVst101 && xVst101.property_code === "VST",
  xVst101 ? `got code=${xVst101.property_code}` : "missing",
);
check(
  "VST/101 picked up address from Property List donor",
  !!xVst101 && xVst101.address === "100 Sunset Drive",
);

const xOak1A = crossMerged.entries.find(
  (e) => e.unit_number === "1A" && _norm(e.property_name) === "oakwood plaza",
);
check(
  "OAK/1A picked up code 'OAK' from Property List via registry",
  !!xOak1A && xOak1A.property_code === "OAK",
);

const v6 = validatePropertyEntries(crossMerged.entries);
check(
  "cross-file merged entries pass validation",
  v6.ok,
  `missingRequired=${v6.missingRequired} duplicatePairs=${v6.duplicatePairs}`,
);

// =============================================================================
// Scenario 7 — registry empty (no file pins a code↔name pairing) →
// rows still merge by their available identity field, no rewrites.
// =============================================================================
console.log(
  "\n[scenario 7] no registry pairings → rows bucket by their own identity",
);

const codeOnlyA = applyMappingToSourceRows(
  ["Code", "Unit"],
  [
    ["VST", "101"],
    ["VST", "102"],
  ],
  {
    property_code: "Code",
    property_name: null,
    property_abbreviation: null,
    address: null,
    city: null,
    state: null,
    zip: null,
    unit_number: "Unit",
    unit_type: null,
    building: null,
    active: null,
    notes: null,
  },
);
const nameOnlyB = applyMappingToSourceRows(
  ["Name", "Unit"],
  [
    ["Vista Apartments", "201"],
    ["Vista Apartments", "202"],
  ],
  {
    property_code: null,
    property_name: "Name",
    property_abbreviation: null,
    address: null,
    city: null,
    state: null,
    zip: null,
    unit_number: "Unit",
    unit_type: null,
    building: null,
    active: null,
    notes: null,
  },
);

const noRegMerged = mergePropertyFiles([
  { filename: "code_only.csv", entries: codeOnlyA.entries },
  { filename: "name_only.csv", entries: nameOnlyB.entries },
]);
check(
  "no cross-file resolutions when no file pins a code+name pairing",
  noRegMerged.stats.crossFileIdentitiesResolved === 0,
  `got crossFileIdentitiesResolved=${noRegMerged.stats.crossFileIdentitiesResolved}`,
);
check(
  "name-only and code-only rows form two parallel property buckets (4 final rows)",
  noRegMerged.stats.finalRowCount === 4,
  `got finalRowCount=${noRegMerged.stats.finalRowCount}`,
);
// Both should still pass validation — PASS-3 mirror fills the missing
// identity fields with placeholders.
const v7 = validatePropertyEntries(noRegMerged.entries);
check(
  "no-registry merged entries still pass validation (PASS-3 mirror)",
  v7.ok,
  `missingRequired=${v7.missingRequired} duplicatePairs=${v7.duplicatePairs}`,
);

// =============================================================================
// Scenario 8 — three-file mix: code-only, name-only, code+name.
// The third file pins the registry; rows from the first two converge.
// =============================================================================
console.log(
  "\n[scenario 8] three-file mix → registry pin makes all three converge",
);

const fileX_codeOnly = applyMappingToSourceRows(
  ["Code", "Unit"],
  [
    ["VST", "101"],
    ["VST", "102"],
  ],
  {
    property_code: "Code",
    property_name: null,
    property_abbreviation: null,
    address: null,
    city: null,
    state: null,
    zip: null,
    unit_number: "Unit",
    unit_type: null,
    building: null,
    active: null,
    notes: null,
  },
);
const fileY_nameOnly = applyMappingToSourceRows(
  ["Name", "Unit"],
  [
    ["Vista Apartments", "203"],
  ],
  {
    property_code: null,
    property_name: "Name",
    property_abbreviation: null,
    address: null,
    city: null,
    state: null,
    zip: null,
    unit_number: "Unit",
    unit_type: null,
    building: null,
    active: null,
    notes: null,
  },
);
const fileZ_pinned = applyMappingToSourceRows(
  ["Code", "Name", "Address"],
  [["VST", "Vista Apartments", "100 Sunset Drive"]],
  {
    property_code: "Code",
    property_name: "Name",
    property_abbreviation: null,
    address: "Address",
    city: null,
    state: null,
    zip: null,
    unit_number: null,
    unit_type: null,
    building: null,
    active: null,
    notes: null,
  },
);

const triMerged = mergePropertyFiles([
  { filename: "code_only.csv", entries: fileX_codeOnly.entries },
  { filename: "name_only.csv", entries: fileY_nameOnly.entries },
  { filename: "pinned.csv", entries: fileZ_pinned.entries },
]);
console.log("  tri-merge stats:", triMerged.stats);
check(
  "registry pin causes the lone name-only row to rewrite to the VST bucket",
  triMerged.stats.crossFileIdentitiesResolved === 1,
  `got crossFileIdentitiesResolved=${triMerged.stats.crossFileIdentitiesResolved}`,
);
check(
  "3 final rows: VST/101, VST/102, VST/203 (donor absorbed)",
  triMerged.stats.finalRowCount === 3,
  `got finalRowCount=${triMerged.stats.finalRowCount}`,
);
check(
  "all 3 final rows share property_code='VST'",
  triMerged.entries.every((e) => e.property_code === "VST"),
);
check(
  "all 3 final rows share property_name='Vista Apartments'",
  triMerged.entries.every((e) => e.property_name === "Vista Apartments"),
);

// =============================================================================
// Scenario 9 - applyMappingToSourceRows drops bare summary footer rows.
//
// The end-to-end ghost Total/Total guard. A flat-table file whose
// footer row carries name="Total" + blank code (or vice versa) used
// to surface as a final Total/Total entry after PASS-3 mirror. The
// frontend now drops these at the materialization layer as defense
// in depth on top of the backend's `_is_summary_row` filter.
// =============================================================================
console.log(
  "\n[scenario 9] applyMappingToSourceRows drops 'Total' footer rows",
);

const totalFooter = applyMappingToSourceRows(
  ["Property Code", "Property Name", "Address"],
  [
    ["VST", "Vista Apartments", "100 Sunset Drive"],
    ["OAK", "Oakwood Plaza", "250 Elm Street"],
    // Footer rows in three shapes the heuristic must catch:
    ["", "Total", ""],            // name-only Total
    ["Total", "", ""],            // code-only Total
    ["Total", "Total", ""],       // both fields are summary tokens
    ["", "Grand Total", ""],      // name-only Grand Total
    ["", "Property Total", ""],   // name-only Property Total
  ],
  {
    property_code: "Property Code",
    property_name: "Property Name",
    property_abbreviation: null,
    address: "Address",
    city: null,
    state: null,
    zip: null,
    unit_number: null,
    unit_type: null,
    building: null,
    active: null,
    notes: null,
  },
);

check(
  "5 footer rows dropped, 2 real rows survive",
  totalFooter.entries.length === 2,
  `got entries=${totalFooter.entries.length}`,
);
check(
  "summaryRowsSkipped count exposes the drop",
  totalFooter.summaryRowsSkipped === 5,
  `got summaryRowsSkipped=${totalFooter.summaryRowsSkipped}`,
);
check(
  "no surviving entry has 'Total' as code or name",
  totalFooter.entries.every(
    (e) =>
      e.property_code.toLowerCase() !== "total" &&
      e.property_name.toLowerCase() !== "total",
  ),
);

// =============================================================================
// Scenario 10 - row with REAL code + the literal name "Total" is KEPT.
// The defensive filter only fires when one identity slot is a token
// AND the other has no real value to anchor on.
// =============================================================================
console.log(
  "\n[scenario 10] real code + quirky name 'Total' is preserved (anchor rule)",
);

const quirky = applyMappingToSourceRows(
  ["Property Code", "Property Name"],
  [
    ["VST", "Vista Apartments"],
    // Has a real code anchoring it -> kept even though name is "Total".
    ["XYZ", "Total"],
  ],
  {
    property_code: "Property Code",
    property_name: "Property Name",
    property_abbreviation: null,
    address: null,
    city: null,
    state: null,
    zip: null,
    unit_number: null,
    unit_type: null,
    building: null,
    active: null,
    notes: null,
  },
);
check(
  "row with real code + quirky 'Total' name preserved",
  quirky.entries.length === 2 && quirky.summaryRowsSkipped === 0,
  `got entries=${quirky.entries.length} skipped=${quirky.summaryRowsSkipped}`,
);

// =============================================================================
// Scenario 11 - end-to-end: footer row never produces a ghost
// Total/Total entry through the full mapping + merge + PASS-3 mirror.
// =============================================================================
console.log(
  "\n[scenario 11] end-to-end: footer row never reaches merged entries",
);

const yardiLikeMapped = applyMappingToSourceRows(
  ["Property Code", "Property Name", "City"],
  [
    ["VST", "Vista Apartments", "Austin"],
    ["OAK", "Oakwood Plaza", "Houston"],
    // The exact pattern we're guarding against: blank code + Total name.
    // Without the filter, PASS-3 mirror would produce {code:"Total", name:"Total"}.
    ["", "Total", ""],
  ],
  {
    property_code: "Property Code",
    property_name: "Property Name",
    property_abbreviation: null,
    address: null,
    city: "City",
    state: null,
    zip: null,
    unit_number: null,
    unit_type: null,
    building: null,
    active: null,
    notes: null,
  },
);

const ghostMerged = mergePropertyFiles([
  { filename: "yardi.csv", entries: yardiLikeMapped.entries },
]);
check(
  "no ghost Total/Total entry survives the full pipeline",
  ghostMerged.entries.every(
    (e) =>
      e.property_code.toLowerCase() !== "total" ||
      e.property_name.toLowerCase() !== "total",
  ),
  "found a Total/Total entry: " +
    JSON.stringify(
      ghostMerged.entries.find(
        (e) =>
          e.property_code.toLowerCase() === "total" &&
          e.property_name.toLowerCase() === "total",
      ),
    ),
);
check(
  "merged entries count matches real properties (no ghost row inflation)",
  ghostMerged.entries.length === 2,
  `got finalRowCount=${ghostMerged.entries.length}`,
);

// =============================================================================
console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);

// ---------------------------------------------------------------------------
// Local helpers (smoke-only, not exported)
// ---------------------------------------------------------------------------
function _norm(v: string | null | undefined): string {
  return (v || "").trim().toLowerCase();
}
