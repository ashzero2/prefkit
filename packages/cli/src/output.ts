import type { DoctorReport, PreferenceRecord, PreferenceStore } from "@prefkit/core";

export function printDoctor(report: DoctorReport): void {
  console.log(`PrefKit doctor: ${report.ok ? "ok" : "needs attention"}`);
  for (const check of report.checks) {
    console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.message}`);
  }
}

export function printList(preferences: PreferenceRecord[]): void {
  if (preferences.length === 0) {
    console.log("No preferences found.");
    return;
  }

  for (const pref of preferences) {
    console.log(
      `${pref.id}  ${pref.status.padEnd(10)}  ${pref.confidence.toFixed(2)}  ${pref.scopeType.padEnd(10)}  ${
        pref.statement
      }`,
    );
  }
}

export function printWhy(record: NonNullable<ReturnType<PreferenceStore["get"]>>): void {
  console.log(`${record.preference.id}: ${record.preference.statement}`);
  console.log(`status=${record.preference.status} confidence=${record.preference.confidence.toFixed(2)}`);
  console.log(
    `scope=${record.preference.scopeType}${record.preference.scopeValue === null ? "" : `:${record.preference.scopeValue}`}`,
  );
  console.log(`category=${record.preference.category} tags=${record.preference.tags.join(", ") || "none"}`);
  if (record.preference.supersedesId !== null) {
    console.log(`supersedes=${record.preference.supersedesId}`);
  }
  console.log("");
  console.log("Evidence:");
  for (const evidence of record.evidence) {
    console.log(`- ${evidence.sourceType} ${evidence.polarity} weight=${evidence.weight}: ${evidence.summary}`);
  }
}

export function printStats(stats: ReturnType<PreferenceStore["stats"]>): void {
  console.log("PrefKit stats");
  console.log(`preferences=${stats.preferences.total}`);
  for (const [status, count] of Object.entries(stats.preferences.byStatus)) {
    console.log(`preferences.${status}=${count}`);
  }
  console.log(`evidence=${stats.evidence.total}`);
  for (const [sourceType, count] of Object.entries(stats.evidence.bySourceType)) {
    console.log(`evidence.source.${sourceType}=${count}`);
  }
  for (const [polarity, count] of Object.entries(stats.evidence.byPolarity)) {
    console.log(`evidence.polarity.${polarity}=${count}`);
  }
  console.log(`metrics.contextRequests=${stats.metrics.contextRequests}`);
  console.log(`metrics.contextMatches=${stats.metrics.contextMatches}`);
  console.log(`metrics.contextHits=${stats.metrics.contextHits}`);
  console.log(`metrics.contextHitRate=${stats.metrics.contextHitRate.toFixed(4)}`);
  console.log(`metrics.contextInjectedRules=${stats.metrics.contextInjectedRules}`);
  console.log(`metrics.contextInjectedTokens=${stats.metrics.contextInjectedTokens}`);
  console.log(`metrics.correctionsAfterContext=${stats.metrics.correctionsAfterContext}`);
  console.log(`metrics.correctionsWithoutContext=${stats.metrics.correctionsWithoutContext}`);
}

export function printOutcomeEvaluation(evaluation: ReturnType<PreferenceStore["evaluateOutcomes"]>): void {
  console.log(`PrefKit outcome evaluation: ${evaluation.status}`);
  console.log(`completedSessions=${evaluation.completedSessions}`);
  console.log(`openSessions=${evaluation.openSessions}`);
  printEvaluationGroup("withContext", evaluation.withContext);
  printEvaluationGroup("withoutContext", evaluation.withoutContext);
  console.log(`absoluteRateDifference=${formatRate(evaluation.absoluteRateDifference)}`);
  console.log(`relativeRateDifference=${formatRate(evaluation.relativeRateDifference)}`);
  console.log("note=Rates use explicitly closed session outcomes; silence is not treated as prevention.");
}

function printEvaluationGroup(
  label: string,
  group: ReturnType<PreferenceStore["evaluateOutcomes"]>["withContext"],
): void {
  console.log(`${label}.sessions=${group.sessions}`);
  console.log(`${label}.corrections=${group.corrections}`);
  console.log(`${label}.correctionRate=${formatRate(group.correctionRate)}`);
}

function formatRate(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(4);
}

export function printMutation(label: string, preference: PreferenceRecord | null): number {
  if (preference === null) {
    console.error("Preference not found.");
    return 1;
  }
  console.log(`${label} ${preference.id}: ${preference.statement}`);
  return 0;
}

export function printHelp(): void {
  console.log(`PrefKit

Usage:
  prefkit init [--config .prefkit.json]
  prefkit remember "Prefer concise status updates" [--category communication] [--tag style] [--reactivate]
  prefkit list [--all] [--status active] [--scope repository] [--scope-value <val>] [--limit 20] [--offset 0]
  prefkit stats
  prefkit evaluate
  prefkit evaluate --session <id> --correction-observed|--no-correction [--with-context|--without-context]
  prefkit why <id>
  prefkit pin <id>
  prefkit forget <id>
  prefkit review <id> --accept|--reject
  prefkit export --format markdown|json
  prefkit import --input ./prefkit-export.json
  prefkit backup --output ./backups/prefs.db
  prefkit context --prompt "I need to name an app" [--why] [--with-header]
  prefkit learn --event-file event.json [--persist]
  prefkit queue --stdin-json [--queue-dir ~/.prefkit/queue]
  prefkit replay [--queue-dir ~/.prefkit/queue] [--persist] [--limit 100] [--max-attempts 3]
    Successful and skipped events move to queue/processed; exhausted failures move to queue/failed.
  prefkit worker [--queue-dir ~/.prefkit/queue] [--interval-ms 5000] [--batch-size 1] [--once]
    Watches the queue and persists learning events in the background. One worker runs per queue.
  prefkit doctor [--config .prefkit.json]
  prefkit opencode install [--write] [--opencode-config opencode.jsonc]
  prefkit opencode doctor [--opencode-config opencode.jsonc]
  prefkit codex install [--write] [--codex-hooks ~/.codex/hooks.json]
  prefkit codex doctor [--codex-hooks ~/.codex/hooks.json]
  prefkit mcp [--config .prefkit.json]
    Serve MCP preference tools over stdio.
`);
}
