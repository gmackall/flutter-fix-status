export function classify(input) {
  const trimmed = input.trim();
  if (/^[0-9a-f]{7,40}$/i.test(trimmed)) return { type: 'commit', value: trimmed };
  const prMatch = trimmed.match(/flutter\/flutter\/pull\/(\d+)/);
  if (prMatch) return { type: 'pr', value: prMatch[1] };
  const prNumberOnly = trimmed.match(/^#?(\d+)$/);
  if (prNumberOnly) return { type: 'maybe-pr-or-issue', value: prNumberOnly[1] };
  const issueMatch = trimmed.match(/flutter\/flutter\/issues\/(\d+)/);
  if (issueMatch) return { type: 'issue', value: issueMatch[1] };
  return { type: 'unknown', value: trimmed };
}

export function ancestorIncludedStatus(status) {
  return status === 'behind' || status === 'identical';
}

export function releasesAgo(latestIndex, firstIndex) {
  if (firstIndex == null) return '—';
  return (latestIndex - firstIndex).toString();
}