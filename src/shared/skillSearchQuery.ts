function normalizeText(input: string): string {
  return input.trim().toLowerCase();
}

function stripGitSuffix(repo: string): string {
  return repo.replace(/\.git$/i, "");
}

function extractGithubOwnerRepo(input: string): string | null {
  const normalized = normalizeText(input);
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

  const ownerRepo = extractGithubOwnerRepo(normalized);
  if (ownerRepo) {
    variants.add(ownerRepo);
  }

  return Array.from(variants);
}

export function resolveSkillSearchLookupQuery(query: string): string {
  const normalized = normalizeText(query);
  if (!normalized) return "";

  return extractGithubOwnerRepo(normalized) || normalized;
}
