/***********************
 * writeback-airtable.mjs
 *
 * Runs after the processed images are committed and pushed. Reads
 * sync-results.json (written by process-images.mjs) and PATCHes each
 * record's URL / Status / Note fields back into Airtable.
 *
 * Runs last deliberately: the permanent URL only goes live once the
 * push has landed, so records are never pointed at a file that isn't
 * on the branch yet.
 ************************/

import fs from "node:fs";

function env(key) {
  const v = process.env[key];
  if (!v) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
  return v;
}

const AIRTABLE_PAT = env("AIRTABLE_PAT");
const BASE_ID      = env("BASE_ID");
const TABLE_ID     = env("TABLE_ID");

const RESULTS_FILE = "sync-results.json";

if (!fs.existsSync(RESULTS_FILE)) {
  console.log("No sync-results.json found — nothing to write back.");
  process.exit(0);
}

const results = JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8"));
if (!Array.isArray(results) || results.length === 0) {
  console.log("No results to write back.");
  process.exit(0);
}

console.log(`Writing ${results.length} record update(s) back to Airtable…`);

// Airtable accepts up to 10 records per PATCH; ~5 requests/sec rate limit.
for (let i = 0; i < results.length; i += 10) {
  const batch = results.slice(i, i + 10);
  const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${AIRTABLE_PAT}`,
      "Content-Type": "application/json",
    },
    // typecast lets the Status single-select create its options on first run
    body: JSON.stringify({ records: batch, typecast: true }),
  });
  if (!resp.ok) {
    console.error(`Airtable PATCH failed: HTTP ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }
  console.log(`  batch ${Math.floor(i / 10) + 1}: ${batch.length} record(s) updated`);
  await new Promise((r) => setTimeout(r, 250));
}

console.log("Write-back complete.");
