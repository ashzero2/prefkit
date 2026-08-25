import type { ContextRenderOptions, PreferenceSearchResult, RenderedContext } from "../retrieval/types.js";

const header = "Relevant user preferences:";

export function renderPreferenceContext(
  results: PreferenceSearchResult[],
  options: ContextRenderOptions,
): RenderedContext {
  const maxRules = Math.max(0, options.injection.maxRules);
  const maxTokens = Math.max(0, options.injection.maxTokens);
  const includeWhy = options.includeWhy ?? options.injection.includeWhy;
  const included: PreferenceSearchResult[] = [];
  const omitted: PreferenceSearchResult[] = [];
  const lines = [header];

  for (const result of results) {
    if (included.length >= maxRules) {
      omitted.push(result);
      continue;
    }

    const line = formatPreferenceLine(result, includeWhy);
    const candidate = [...lines, line].join("\n");
    if (estimateTokens(candidate) > maxTokens) {
      omitted.push(result);
      continue;
    }

    lines.push(line);
    included.push(result);
  }

  if (included.length === 0) {
    return {
      text: "",
      tokenEstimate: 0,
      included,
      omitted: results,
    };
  }

  const text = `${lines.join("\n")}\n`;
  return {
    text,
    tokenEstimate: estimateTokens(text),
    included,
    omitted,
  };
}

export function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  return Math.ceil(text.length / 4);
}

function formatPreferenceLine(result: PreferenceSearchResult, includeWhy: boolean): string {
  const pref = result.preference;
  const scope = pref.scopeValue === null ? pref.scopeType : `${pref.scopeType}:${pref.scopeValue}`;
  const suffix = includeWhy ? ` [${result.reasons.join(", ")}; confidence ${Math.round(pref.confidence * 100)}%]` : "";
  return `- ${pref.statement} (${scope}, ${pref.category})${suffix}`;
}
