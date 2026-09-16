#!/usr/bin/env node
// Keeps src/version.ts in step with package.json.
//
// VERSION goes on the wire: http.ts sends it as the User-Agent, so a stale
// literal misreports which client a request came from -- and a hand-maintained
// second copy of a version number drifts the first time someone bumps in a
// hurry. It cannot simply be imported from package.json: tsconfig sets
// rootDir to src, and a file outside that root is not compilable. So it is
// generated, and `prebuild` runs this before every build.
//
// With --check it asserts rather than writes, which is what CI runs so a
// stale committed file fails the pull request instead of shipping.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const target = join(root, "src", "version.ts");
const wanted = `export const VERSION = ${JSON.stringify(version)};\n`;

if (readFileSync(target, "utf8") === wanted) {
  process.exit(0);
}

if (process.argv.includes("--check")) {
  console.error(
    `src/version.ts is stale: package.json says ${version}. Run \`npm run build\` and commit the result.`,
  );
  process.exit(1);
}

writeFileSync(target, wanted);
console.log(`src/version.ts -> ${version}`);
