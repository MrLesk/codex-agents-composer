import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const rootDir = path.resolve(import.meta.dirname, "..");
const packageJsonPath = path.join(rootDir, "package.json");

function readPackageJson() {
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
}

function parseReleaseTag(rawTag) {
  const releaseTag = rawTag || "";
  const releasedVersion = releaseTag.replace(/^v/, "");
  const match = releasedVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(
      `Release tag "${releaseTag}" must be semver like v1.2.3 or 1.2.3.`,
    );
  }
  return {
    releasedVersion,
  };
}

function resolveValue(arg, envKey) {
  return arg || process.env[envKey] || "";
}

function setVersion(version) {
  const packageJson = readPackageJson();
  packageJson.version = version;
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, `PACKAGE_VERSION=${version}\n`);
  }
}

function setVersionFromReleaseTag(rawTag) {
  const { releasedVersion } = parseReleaseTag(rawTag);
  setVersion(releasedVersion);
}

const [command, arg] = process.argv.slice(2);

switch (command) {
  case "set-version":
    if (!resolveValue(arg, "PACKAGE_VERSION")) {
      throw new Error("set-version requires a semver argument.");
    }
    setVersion(resolveValue(arg, "PACKAGE_VERSION"));
    break;
  case "set-version-from-release-tag":
    setVersionFromReleaseTag(resolveValue(arg, "RELEASE_TAG"));
    break;
  default:
    throw new Error(
      "Usage: node scripts/sync-version.mjs <set-version|set-version-from-release-tag> [value]",
    );
}
