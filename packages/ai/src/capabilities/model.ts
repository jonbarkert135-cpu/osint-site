/**
 * The capabilities that need a model (14_AI_AGENT.md §5). Each one produces text only; text
 * becomes graph content solely through a proposal the user accepts (N4), and every generated
 * note carries `derived_from` edges back to the nodes it was written from (provenance-first).
 */

import type { BoardNode } from '@nexus/domain';
import type { ImportProposal, ProposalItem } from '@nexus/integrations/pipeline';

import { aiProvenance, buildAIProposal, edgeItem, existingRef, noteItem } from '../proposal.ts';
import { AIUnavailableError } from '../provider.ts';
import { nodeText, type AICapability, type AIRunContext } from '../types.ts';

const MAX_CONTEXT_NODES = 40;

function selected(ctx: AIRunContext): readonly BoardNode[] {
  const live = ctx.graph.nodes.filter((node) => node.status === 'active');
  if (ctx.nodeIds === undefined || ctx.nodeIds.length === 0) return live;
  const wanted = new Set(ctx.nodeIds);
  return live.filter((node) => wanted.has(node.id));
}

function noteProposal(
  ctx: AIRunContext,
  title: string,
  text: string,
  sources: readonly BoardNode[],
  explain: string,
): ImportProposal {
  const provenance = aiProvenance({
    runId: ctx.runId,
    model: ctx.provider.modelId,
    now: ctx.now,
    actorUserId: ctx.actorUserId,
    confidence: 0.6,
    explain,
  });
  const noteTempId = ctx.newId();
  const items: ProposalItem[] = [noteItem(noteTempId, title, text, provenance, explain)];
  for (const source of sources) {
    items.push(
      edgeItem(
        ctx.newId(),
        { kind: 'temp', tempId: noteTempId },
        existingRef(source.id),
        'derived_from',
        provenance,
        `The note was written from "${source.title}".`,
        true,
      ),
    );
  }
  return buildAIProposal({
    proposalId: ctx.newId(),
    runId: ctx.runId,
    boardId: ctx.boardId,
    now: ctx.now,
    items,
  });
}

/** §16 — summarise a node / analyse a document / explain a repository: same shape, one prompt. */
export const summarizeNode: AICapability = {
  id: 'summarize-node',
  needsProvider: true,
  description: 'Summarises the selected node into a proposed note linked back to its source.',
  async run(ctx) {
    const node = selected(ctx)[0];
    if (node === undefined) throw new AIUnavailableError('summarize-node needs a selected node');
    const text = await ctx.provider.complete(
      `Summarise the following ${node.type} for a research board. Six sentences maximum, plain text, no preamble.\n\n${nodeText(node)}`,
    );
    const explain = `Summary of "${node.title}" produced by ${ctx.provider.modelId}.`;
    return {
      runId: ctx.runId,
      capability: 'summarize-node',
      model: ctx.provider.modelId,
      explanation: `${explain} Nothing was written: accept the proposed note to add it.`,
      findings: [
        { id: node.id, title: `Summary of ${node.title}`, detail: text, nodeIds: [node.id] },
      ],
      proposal: noteProposal(ctx, `Summary — ${node.title}`, text, [node], explain),
    };
  },
};

/** §16 — "объяснять connection". Read-only by design: an explanation is not board content. */
export const explainConnection: AICapability = {
  id: 'explain-connection',
  needsProvider: true,
  description: 'Explains in prose why two connected nodes are linked. Never writes.',
  async run(ctx) {
    const edge = ctx.graph.edges.find((candidate) => candidate.id === ctx.edgeId);
    if (edge === undefined) throw new AIUnavailableError('explain-connection needs an edge id');
    const byId = new Map(ctx.graph.nodes.map((node) => [node.id, node]));
    const from = byId.get(edge.source.nodeId);
    const to = byId.get(edge.target.nodeId);
    if (from === undefined || to === undefined) {
      throw new AIUnavailableError('the edge endpoints are not on this board');
    }
    const text = await ctx.provider.complete(
      `Two items on a research board are linked with the relation "${edge.type}". Explain in at most four sentences what that link means and what would confirm or refute it.\n\nA: ${nodeText(from)}\n\nB: ${nodeText(to)}`,
    );
    return {
      runId: ctx.runId,
      capability: 'explain-connection',
      model: ctx.provider.modelId,
      explanation: `Explanation of the "${edge.type}" link between "${from.title}" and "${to.title}" by ${ctx.provider.modelId}. Read-only capability.`,
      findings: [
        {
          id: edge.id,
          title: `${from.title} —${edge.type}→ ${to.title}`,
          detail: text,
          nodeIds: [from.id, to.id],
        },
      ],
    };
  },
};

/** §16 — "создавать investigation summary" over the board or the current selection. */
export const investigationSummary: AICapability = {
  id: 'investigation-summary',
  needsProvider: true,
  description: 'Writes an investigation summary of the board as a proposed note.',
  async run(ctx) {
    const nodes = selected(ctx).slice(0, MAX_CONTEXT_NODES);
    if (nodes.length === 0) throw new AIUnavailableError('the board has no active nodes');
    const context = nodes
      .map((node, index) => `${String(index + 1)}. [${node.type}] ${nodeText(node)}`)
      .join('\n');
    const text = await ctx.provider.complete(
      `You are summarising an OSINT-style investigation board. Write a concise summary: what is known, what connects, and what is still open. Plain text, no preamble.\n\n${context}`,
    );
    const explain = `Investigation summary over ${String(nodes.length)} node(s) by ${ctx.provider.modelId}.`;
    return {
      runId: ctx.runId,
      capability: 'investigation-summary',
      model: ctx.provider.modelId,
      explanation: `${explain} The note is a proposal; the board is unchanged until you accept it.`,
      findings: [
        {
          id: ctx.runId,
          title: 'Investigation summary',
          detail: text,
          nodeIds: nodes.map((node) => node.id),
        },
      ],
      proposal: noteProposal(ctx, 'Investigation summary', text, nodes, explain),
    };
  },
};

/** §16 — "генерация заметок": one drafted note from whatever is selected. */
export const generateNote: AICapability = {
  id: 'generate-note',
  needsProvider: true,
  description: 'Drafts a research note from the selected cards, proposed for review.',
  async run(ctx) {
    const nodes = selected(ctx).slice(0, MAX_CONTEXT_NODES);
    if (nodes.length === 0) throw new AIUnavailableError('generate-note needs at least one node');
    const context = nodes.map((node) => `[${node.type}] ${nodeText(node)}`).join('\n\n');
    const text = await ctx.provider.complete(
      `Draft one research note from the material below: the facts it establishes, the open questions, and what to check next. Plain text, no preamble.\n\n${context}`,
    );
    const explain = `Note drafted from ${String(nodes.length)} card(s) by ${ctx.provider.modelId}.`;
    return {
      runId: ctx.runId,
      capability: 'generate-note',
      model: ctx.provider.modelId,
      explanation: `${explain} Nothing was written: accept the proposal to add the note.`,
      findings: [
        {
          id: ctx.runId,
          title: 'Drafted note',
          detail: text,
          nodeIds: nodes.map((node) => node.id),
        },
      ],
      proposal: noteProposal(ctx, 'Note — drafted', text, nodes, explain),
    };
  },
};

/** §16 — "анализ документов": the selected document/file card, read for claims and entities. */
export const analyzeDocument: AICapability = {
  id: 'analyze-document',
  needsProvider: true,
  description: 'Reads the selected document card and proposes a note of its claims and entities.',
  async run(ctx) {
    const node = selected(ctx)[0];
    if (node === undefined) throw new AIUnavailableError('analyze-document needs a selected card');
    const text = await ctx.provider.complete(
      `Analyse this document for a research board. List its key claims, the entities it names (people, organisations, domains, addresses), and anything that looks unverified. Plain text, no preamble.\n\n${nodeText(node)}`,
    );
    const explain = `Document analysis of "${node.title}" by ${ctx.provider.modelId}.`;
    return {
      runId: ctx.runId,
      capability: 'analyze-document',
      model: ctx.provider.modelId,
      explanation: `${explain} The extracted claims are the model's reading, not verified facts.`,
      findings: [
        { id: node.id, title: `Analysis of ${node.title}`, detail: text, nodeIds: [node.id] },
      ],
      proposal: noteProposal(ctx, `Analysis — ${node.title}`, text, [node], explain),
    };
  },
};

/** §16 — "объяснение репозитория": what a repository card is, in prose. Read-only. */
export const explainRepository: AICapability = {
  id: 'explain-repository',
  needsProvider: true,
  description: 'Explains what the selected repository does and how it could be integrated.',
  async run(ctx) {
    const node = selected(ctx).find(
      (candidate) =>
        typeof candidate.data['url'] === 'string' && typeof candidate.data['owner'] === 'string',
    );
    if (node === undefined) {
      throw new AIUnavailableError('explain-repository needs a selected repository card');
    }
    const text = await ctx.provider.complete(
      `Explain this source-code repository for a non-programmer analyst: what it does, what it needs to run, and how it could be plugged into an OSINT board. At most six sentences, plain text.\n\n${nodeText(node)}`,
    );
    return {
      runId: ctx.runId,
      capability: 'explain-repository',
      model: ctx.provider.modelId,
      explanation: `Explanation of "${node.title}" by ${ctx.provider.modelId}. Read-only capability: nothing is written to the board.`,
      findings: [{ id: node.id, title: `About ${node.title}`, detail: text, nodeIds: [node.id] }],
    };
  },
};
