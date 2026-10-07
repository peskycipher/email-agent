import {
  runLiveApply as runLiveApplyInternal,
  type LiveApplyOptions,
  type LiveApplyResult
} from "./apply.ts";
import {
  runDryRun as runDryRunInternal,
  type DryRunOptions,
  type DryRunResult
} from "./dry_run.ts";

export type OrchestratorDryRunDeps = DryRunOptions;
export type OrchestratorLiveApplyDeps = LiveApplyOptions;

export async function runDryRun(deps: OrchestratorDryRunDeps): Promise<DryRunResult> {
  return runDryRunInternal(deps);
}

export async function runLiveApply(deps: OrchestratorLiveApplyDeps): Promise<LiveApplyResult> {
  return runLiveApplyInternal(deps);
}
