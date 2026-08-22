/**
 * The integration surface: picker → consent → run → proposal → apply (10_INTEGRATIONS.md §7).
 *
 * One component owns the whole flow because the flow *is* one decision the analyst makes; splitting
 * it across routes would only mean rebuilding the same state in three places. It is mounted only
 * where the `integrations` capability is on, so in local mode the entire surface is absent (N2).
 *
 * Stage 8 runs client-side through `applyProposal`, which is the single write path into the Y.Doc
 * (N4) and gives exactly one undo step per accepted proposal (N3).
 */

import { applyProposal, type ImportProposal } from '@nexus/integrations';
import type { IntegrationErrorCode } from '@nexus/integrations/errors';
import { newId } from '@nexus/domain';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import type * as Y from 'yjs';

import { useWorkspace } from '../data/workspace/context.tsx';
import type { RunsRepository } from '../data/workspace/runs.ts';
import { ApplyToast } from './ApplyToast.tsx';
import { ConsentDialog } from './ConsentDialog.tsx';
import { IntegrationPicker } from './IntegrationPicker.tsx';
import { ProposalReview } from './ProposalReview.tsx';
import { RunHistory } from './RunHistory.tsx';
import { RunPanel } from './RunPanel.tsx';
import { externalRunUrl } from './externalRun.ts';
import { installedIntegrations } from './useIntegrations.ts';
import type { IntegrationSummary, RunUiState } from './types.ts';

export interface IntegrationsSurfaceProps {
  open: boolean;
  onClose: () => void;
  doc: Y.Doc;
  boardId: string;
  projectId: string;
  /** The current canvas selection, already resolved to titles by the caller. */
  selection: readonly { id: string; kind: string; label: string }[];
  onUndo: () => void;
  /** Injected in tests; production reads the manifest registry. */
  integrations?: readonly IntegrationSummary[];
}

type Step = 'picker' | 'consent' | 'run' | 'review';

const ACTIVE_STATES = new Set(['queued', 'starting', 'running', 'parsing']);

export function IntegrationsSurface({
  open,
  onClose,
  doc,
  boardId,
  projectId,
  selection,
  onUndo,
  integrations,
}: IntegrationsSurfaceProps) {
  const runs = useWorkspace().runs;
  const list = integrations ?? installedIntegrations();

  const [step, setStep] = useState<Step>('picker');
  const [chosen, setChosen] = useState<IntegrationSummary | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [errorCode, setErrorCode] = useState<IntegrationErrorCode | undefined>(undefined);
  const [externalUrl, setExternalUrl] = useState<string | undefined>(undefined);
  const [proposal, setProposal] = useState<ImportProposal | null>(null);
  const [applied, setApplied] = useState<{
    nodes: number;
    edges: number;
    integrationName: string;
  } | null>(null);

  const runQuery = useQuery({
    queryKey: ['integrations', 'runs', boardId],
    queryFn: () => (runs as RunsRepository).listRuns({ boardId }),
    enabled: open && runs !== undefined,
    refetchInterval: step === 'run' ? 1500 : false,
  });
  const logQuery = useQuery({
    queryKey: ['integrations', 'runlog', runId],
    queryFn: () => (runs as RunsRepository).getRunLog({ runId: runId ?? '' }),
    enabled: step === 'run' && runId !== null && runs !== undefined,
    refetchInterval: 1500,
  });

  const rows = runQuery.data?.runs ?? [];
  const current = rows.find((run) => run.id === runId);
  const state = (current?.status ?? 'queued') as RunUiState;

  const start = useCallback(
    async (integration: IntegrationSummary) => {
      if (runs === undefined) return;
      const target = selection[0];
      const input: Record<string, unknown> = {};
      for (const field of integration.inputs) {
        if (field.fromSelection && target !== undefined) input[field.name] = target.label;
      }
      const targets =
        target === undefined
          ? []
          : [{ kind: target.kind, value: target.label, scope: 'public-index' as const }];
      setStep('run');
      setErrorCode(undefined);
      setExternalUrl(externalRunUrl(integration.id, input));
      setStartedAt(Date.now());
      try {
        const { consentToken } = await runs.acceptConsent({
          projectId,
          integrationId: integration.id,
          scope: 'public-index',
          targets,
          scopeText: integration.consent.scopeText,
        });
        const started = await runs.startRun({
          integrationId: integration.id,
          projectId,
          boardId,
          ...(target === undefined ? {} : { anchorNodeId: target.id }),
          input,
          targets,
          consentToken,
        });
        setRunId(started.runId);
      } catch {
        // Anything the server refuses is already a taxonomy code; without one, this is our fault.
        setErrorCode('INTERNAL');
      }
    },
    [runs, selection, projectId, boardId],
  );

  const review = useCallback(async () => {
    const proposalId = current?.proposalId;
    if (runs === undefined || proposalId === undefined || proposalId === null) return;
    setProposal((await runs.getProposal({ proposalId })) as ImportProposal);
    setStep('review');
  }, [runs, current]);

  const apply = useCallback(
    (selectedItemIds: string[]) => {
      if (proposal === null || chosen === null) return;
      const result = applyProposal(doc, proposal, {
        selectedItemIds,
        conflictResolutions: {},
        placement: 'radial',
        newId: () => newId.board(),
        now: new Date().toISOString(),
      });
      setApplied({
        nodes: result.createdNodeIds.length,
        edges: result.createdEdgeIds.length,
        integrationName: chosen.name,
      });
      setStep('run');
    },
    [proposal, chosen, doc],
  );

  if (!open || runs === undefined) return null;

  return (
    <aside className="nx-integrations" aria-label="Integrations" data-testid="integrations-surface">
      <button type="button" onClick={onClose} aria-label="Close integrations">
        Close
      </button>

      {step === 'picker' ? (
        <IntegrationPicker
          integrations={list}
          selectionKinds={selection.map((node) => node.kind)}
          onPick={(integration) => {
            setChosen(integration);
            setStep('consent');
          }}
        />
      ) : null}

      <ConsentDialog
        open={step === 'consent'}
        integration={chosen}
        targets={selection.map((node) => ({ kind: node.kind, value: node.label }))}
        onCancel={() => setStep('picker')}
        onConfirm={(integration) => void start(integration)}
      />

      {step === 'run' && chosen !== null ? (
        <RunPanel
          state={state}
          integrationName={chosen.name}
          runId={runId ?? ''}
          elapsedMs={startedAt === 0 ? 0 : Date.now() - startedAt}
          log={logQuery.data ?? []}
          errorCode={errorCode ?? (state === 'failed' ? 'INTERNAL' : undefined)}
          itemsFound={current?.proposalId === null ? 0 : undefined}
          onCancel={
            ACTIVE_STATES.has(state) && runId !== null
              ? () => void runs.cancelRun({ runId })
              : undefined
          }
          externalUrl={externalUrl}
          onRetry={() => void start(chosen)}
          onReview={() => void review()}
        />
      ) : null}

      {step === 'review' && proposal !== null && chosen !== null ? (
        <ProposalReview
          proposal={proposal}
          integrationName={chosen.name}
          onApply={apply}
          onDiscard={() => setStep('run')}
        />
      ) : null}

      <RunHistory
        runs={rows}
        integrations={list}
        onViewLog={(run) => {
          setRunId(run.id);
          setStep('run');
        }}
        onRerun={(run) => {
          const integration = list.find((item) => item.id === run.integrationId);
          if (integration !== undefined) {
            setChosen(integration);
            setStep('consent');
          }
        }}
        onDiff={(run) => {
          setRunId(run.id);
          setStep('run');
        }}
      />

      <ApplyToast
        result={applied}
        onUndo={() => {
          onUndo();
          setApplied(null);
        }}
        onViewRun={() => {
          setApplied(null);
          setStep('run');
        }}
        onDismiss={() => setApplied(null)}
      />
    </aside>
  );
}
