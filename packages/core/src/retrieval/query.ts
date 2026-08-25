const stopwords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "do",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "need",
  "of",
  "on",
  "or",
  "please",
  "should",
  "the",
  "this",
  "to",
  "use",
  "we",
  "what",
  "with",
  "you",
]);

export function queryTerms(input: string): string[] {
  const matches = input.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const terms = matches.filter((term) => term.length >= 3 && !stopwords.has(term));
  return Array.from(new Set(terms)).slice(0, 12);
}

export function ftsQuery(input: string): string | null {
  const terms = queryTerms(input);
  if (terms.length === 0) {
    return null;
  }

  return terms.map((term) => `${quoteFtsTerm(prefixStem(term))}*`).join(" OR ");
}

export function lexicalOverlap(query: string, target: string): number {
  const terms = queryTerms(query);
  if (terms.length === 0) {
    return 0;
  }

  const targetTerms = new Set(queryTerms(target));
  return terms.filter((term) => targetTerms.has(term) || targetTerms.has(prefixStem(term))).length;
}

function prefixStem(term: string): string {
  return term.length <= 4 ? term : term.slice(0, Math.max(3, Math.min(5, term.length - 1)));
}

function quoteFtsTerm(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}
