/**
 * Repository Analysis surface (11_GITHUB.md §5.10, §6; 37_*).
 *
 * Presentational only: the caller supplies the analysis, the proposal and — when the run failed —
 * an error. Measured facts (language, layout, entry point, interfaces, dependencies) are printed
 * as they were measured; the proposal is always labelled as a draft that needs human review; a
 * failure offers the three concrete ways forward (retry, open the repository, analyze manually)
 * instead of one generic "something went wrong".
 */

import type { RepositoryAnalysis } from '@nexus/domain';
import { Banner, Button } from '@nexus/ui';

export interface RepositoryProposalView {
  executionMode: 'container' | 'http-api' | 'unsupported';
  confidence: number;
  blockers: readonly string[];
  adapter: string | null;
  nodeKinds: readonly string[];
  rationale: string;
}

export interface RepositoryAnalysisPanelProps {
  repoKey: string;
  repositoryUrl: string;
  analysis: RepositoryAnalysis | null;
  proposal?: RepositoryProposalView | null;
  /** Present when the last analysis attempt failed; suppresses the analysis body. */
  error?: { title: string; detail: string } | null;
  onRetry: () => void;
  onAnalyzeManually: () => void;
}

/** Interfaces the repo exposes, as short labels — empty when the analysis found none. */
export function interfaceLabels(analysis: RepositoryAnalysis): string[] {
  const labels: string[] = [];
  if (analysis.surface.cli.length > 0) labels.push(`CLI (${String(analysis.surface.cli.length)})`);
  if (analysis.surface.http.framework !== null || analysis.surface.http.routes.length > 0) {
    labels.push(analysis.surface.http.framework ?? 'HTTP');
  }
  if (analysis.surface.grpc.length > 0) labels.push('gRPC');
  if (analysis.surface.library) labels.push('Library');
  if (analysis.surface.mcp) labels.push('MCP');
  return labels;
}

/**
 * Integration complexity, from the facts the analysis already measured: a repo with no entry
 * point, no container and a non-permissive licence is work; a containerised CLI is not.
 */
export function complexityOf(analysis: RepositoryAnalysis): 'low' | 'medium' | 'high' {
  let points = 0;
  if (analysis.entryPoints.length === 0) points += 2;
  if (analysis.container.dockerfile === null && analysis.container.publishedImageHints.length === 0)
    points += 1;
  if (analysis.health.license.permissive !== true) points += 1;
  if (analysis.health.maintenanceBand === 'at-risk') points += 1;
  if (analysis.health.maintenanceBand === 'unmaintained') points += 2;
  if (analysis.completeness < 0.8) points += 1;
  if (points >= 4) return 'high';
  return points >= 2 ? 'medium' : 'low';
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="nx-analysis-row">
      <span className="nx-muted">{label}</span>
      <span>{value}</span>
    </div>
  );
}

export function RepositoryAnalysisPanel({
  repoKey,
  repositoryUrl,
  analysis,
  proposal,
  error,
  onRetry,
  onAnalyzeManually,
}: RepositoryAnalysisPanelProps) {
  const openRepository = (
    <Button
      variant="ghost"
      onClick={() => {
        window.open(repositoryUrl, '_blank', 'noopener,noreferrer');
      }}
      data-testid="analysis-open-repository"
    >
      Open Repository
    </Button>
  );

  return (
    <section
      className="nx-analysis-panel"
      aria-label="Repository analysis"
      data-testid="repository-analysis-panel"
    >
      <header>
        <strong>{repoKey}</strong>
        {openRepository}
      </header>

      {error ? (
        <>
          <Banner kind="danger" title={error.title}>
            {error.detail}
          </Banner>
          <div className="nx-analysis-actions">
            <Button variant="primary" onClick={onRetry} data-testid="analysis-retry">
              Retry
            </Button>
            {openRepository}
            <Button variant="ghost" onClick={onAnalyzeManually} data-testid="analysis-manual">
              Analyze Manually
            </Button>
          </div>
        </>
      ) : analysis === null ? (
        <p className="nx-muted" data-testid="analysis-empty">
          This repository has not been analyzed yet. Run the analysis to see its languages, entry
          points and integration options.
        </p>
      ) : (
        <>
          <div className="nx-analysis-grid" data-testid="analysis-facts">
            <Row label="Language" value={analysis.primaryLanguage ?? 'unknown'} />
            <Row label="Architecture" value={analysis.layout.kind} />
            <Row
              label="Entry point"
              value={
                analysis.entryPoints[0] === undefined
                  ? 'none found'
                  : `${analysis.entryPoints[0].name} (${analysis.entryPoints[0].type})`
              }
            />
            <Row
              label="Interfaces"
              value={
                interfaceLabels(analysis).length === 0
                  ? 'none detected'
                  : interfaceLabels(analysis).join(', ')
              }
            />
            <Row label="Integration complexity" value={complexityOf(analysis)} />
            <Row
              label="Dependencies"
              value={String(analysis.dependencies.reduce((sum, dep) => sum + dep.direct, 0))}
            />
          </div>

          {analysis.narrative.architecture === null ? null : (
            <p data-testid="analysis-narrative">{analysis.narrative.architecture}</p>
          )}

          {proposal === null || proposal === undefined ? null : (
            <div className="nx-analysis-proposal" data-testid="analysis-proposal">
              <strong>Integration proposal (draft — needs review)</strong>
              <Row label="Possible adapter" value={proposal.adapter ?? proposal.executionMode} />
              <Row
                label="Possible node types"
                value={
                  proposal.nodeKinds.length === 0 ? 'none proposed' : proposal.nodeKinds.join(', ')
                }
              />
              <Row label="Confidence" value={`${String(Math.round(proposal.confidence * 100))}%`} />
              {proposal.blockers.length > 0 ? (
                <Banner kind="warn" title="Blockers before this can be installed">
                  {proposal.blockers.join(', ')}
                </Banner>
              ) : null}
              <p className="nx-muted">{proposal.rationale}</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
