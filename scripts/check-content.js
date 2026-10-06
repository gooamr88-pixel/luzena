// Lists what is still missing from content/site.json. Exits 1 if anything required is
// missing, so it can gate a deployment.
import { loadContent } from "../build/content.js";

const profile = process.argv.includes("--sample") ? "sample" : "production";
// Reads CLOVER_ORDERING_URL from the environment, as the build on the hosting service does.
const { issues } = loadContent(profile, process.env);

console.log(`Content profile: ${profile}\n`);
if (issues.errors.length > 0) {
  console.log(`REQUIRED (${issues.errors.length}) - the production build will not run until these are supplied:`);
  for (const error of issues.errors) console.log(`  - ${error}`);
  console.log("");
}
if (issues.warnings.length > 0) {
  console.log(`OPTIONAL (${issues.warnings.length}) - the site builds without these, with the feature left out:`);
  for (const warning of issues.warnings) console.log(`  - ${warning}`);
  console.log("");
}
if (issues.errors.length === 0) console.log("All required content is present.");
process.exit(issues.errors.length > 0 ? 1 : 0);
