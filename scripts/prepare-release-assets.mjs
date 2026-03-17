import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const releaseTag = process.env.RELEASE_TAG || "";
const version = releaseTag.replace(/^v/, "");

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`RELEASE_TAG must be semver like v1.2.3 or 1.2.3. Received "${releaseTag}".`);
}

const sourceDir = process.argv[2];
const outputDir = process.argv[3];

if (!sourceDir || !outputDir) {
  throw new Error("Usage: node scripts/prepare-release-assets.mjs <sourceDir> <outputDir>");
}

const absoluteSourceDir = path.resolve(sourceDir);
const absoluteOutputDir = path.resolve(outputDir);

fs.rmSync(absoluteOutputDir, { recursive: true, force: true });
fs.mkdirSync(absoluteOutputDir, { recursive: true });

for (const entry of fs.readdirSync(absoluteSourceDir, { withFileTypes: true })) {
  if (!entry.isFile()) continue;

  const sourcePath = path.join(absoluteSourceDir, entry.name);
  const match = entry.name.match(/^stable-([^-]+)-([^-]+)-(.+)$/);
  if (!match) {
    fs.copyFileSync(sourcePath, path.join(absoluteOutputDir, entry.name));
    continue;
  }

  const [, platform, arch, suffix] = match;
  const platformArch = `${platform}_${arch}`;
  let targetName;

  if (suffix === "update.json") {
    targetName = `CodexAgentsComposer_${version}_${platformArch}_update.json`;
  } else {
    targetName = `CodexAgentsComposer_${version}_${platformArch}${path.extname(suffix)}`;

    if (suffix.endsWith(".tar.zst")) {
      targetName = `CodexAgentsComposer_${version}_${platformArch}.tar.zst`;
    } else if (suffix.endsWith(".tar.gz")) {
      targetName = `CodexAgentsComposer_${version}_${platformArch}.tar.gz`;
    }
  }

  fs.copyFileSync(sourcePath, path.join(absoluteOutputDir, targetName));
}
