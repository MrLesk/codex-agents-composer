function normalizeText(input: string): string {
  return input.trim().toLowerCase();
}

function withCompactSlashes(input: string): string {
  return input.replace(/\s*\/\s*/g, "/");
}

function withHyphenatedSpaces(input: string): string {
  return input.replace(/\s+/g, "-").replace(/-+/g, "-");
}

function isUrlLike(input: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(input);
}

function shouldHyphenate(input: string): boolean {
  if (isUrlLike(input)) {
    return false;
  }

  // Keep owner/repo and slash-based queries intact.
  if (input.includes("/")) {
    return false;
  }

  return true;
}

function stripGitSuffix(repo: string): string {
  return repo.replace(/\.git$/i, "");
}

function extractGithubOwnerRepo(input: string): string | null {
  const normalized = withCompactSlashes(normalizeText(input));
  if (!normalized) return null;

  const githubUrlMatch = normalized.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^\/?#]+)\/([^\/?#]+)(?:[\/?#]|$)/i,
  );
  if (githubUrlMatch) {
    const owner = githubUrlMatch[1];
    const repo = stripGitSuffix(githubUrlMatch[2]);
    return `${owner}/${repo}`;
  }

  const githubHostMatch = normalized.match(
    /^(?:www\.)?github\.com\/([^\/?#]+)\/([^\/?#]+)(?:[\/?#]|$)/i,
  );
  if (githubHostMatch) {
    const owner = githubHostMatch[1];
    const repo = stripGitSuffix(githubHostMatch[2]);
    return `${owner}/${repo}`;
  }

  const rawGithubMatch = normalized.match(
    /^https?:\/\/raw\.githubusercontent\.com\/([^\/?#]+)\/([^\/?#]+)\/[^\s]+/i,
  );
  if (rawGithubMatch) {
    const owner = rawGithubMatch[1];
    const repo = stripGitSuffix(rawGithubMatch[2]);
    return `${owner}/${repo}`;
  }

  const skillsShMatch = normalized.match(
    /^https?:\/\/(?:www\.)?skills\.sh\/([^\/?#]+)\/([^\/?#]+)(?:[\/?#]|$)/i,
  );
  if (skillsShMatch) {
    const owner = skillsShMatch[1];
    const repo = stripGitSuffix(skillsShMatch[2]);
    return `${owner}/${repo}`;
  }

  const plainRepoMatch = normalized.match(/^([^\s/@]+\/[^\s/@]+)(?:@[^\s]+)?$/i);
  if (plainRepoMatch) {
    const [owner, repoRaw] = plainRepoMatch[1].split("/");
    const repo = stripGitSuffix(repoRaw || "");
    if (owner && repo) {
      return `${owner}/${repo}`;
    }
  }

  const remotePrefixedMatch = normalized.match(
    /^remote:([^\s/@]+\/[^\s/@]+)\/[^\s]+$/i,
  );
  if (remotePrefixedMatch) {
    return remotePrefixedMatch[1];
  }

  return null;
}

export function buildSkillSearchQueryVariants(query: string): string[] {
  const normalized = normalizeText(query);
  if (!normalized) return [];

  const variants = new Set<string>();
  variants.add(normalized);

  const compacted = withCompactSlashes(normalized);
  if (compacted !== normalized) {
    variants.add(compacted);
  }

  if (shouldHyphenate(compacted)) {
    variants.add(withHyphenatedSpaces(compacted));
  }

  const ownerRepo = extractGithubOwnerRepo(normalized);
  if (ownerRepo) {
    variants.add(ownerRepo);
  }

  return Array.from(variants);
}

export function resolveSkillSearchLookupQuery(query: string): string {
  const normalized = normalizeText(query);
  if (!normalized) return "";

  const ownerRepo = extractGithubOwnerRepo(normalized);
  if (ownerRepo) {
    return ownerRepo;
  }

  const compacted = withCompactSlashes(normalized);
  return shouldHyphenate(compacted)
    ? withHyphenatedSpaces(compacted)
    : compacted;
}
