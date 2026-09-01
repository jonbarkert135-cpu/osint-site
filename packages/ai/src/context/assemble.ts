/**
 * The token-budget algorithm (14_AI_AGENT.md §6.2). Four tiers — focus (selected nodes),
 * neighbours (1 hop), retrieval chunks, board metadata — with fixed shares 55/15/25/5 of the
 * available budget; whole members are added best-first, a member too large for its tier is
 * head-tail truncated and flagged, and unspent allocation cascades to the next tier. Pure and
 * browser-safe (N2): tokens are the chars/4 estimate ×1.15 safety unless a counter is injected.
 */

export type ContextTier = 'focus' | 'neighbours' | 'retrieval' | 'metadata';

export interface ContextMember {
  readonly id: string;
  /** Already serialized (§6.1) and rank-ordered best-first within its tier. */
  readonly text: string;
}

export interface AssembledMember {
  readonly id: string;
  readonly tier: ContextTier;
  readonly text: string;
  /** True when the member was head-tail truncated to fit its allocation (§6.2). */
  readonly truncated: boolean;
}

export interface AssembleOptions {
  readonly focus: readonly ContextMember[];
  readonly neighbours?: readonly ContextMember[];
  readonly retrieval?: readonly ContextMember[];
  readonly metadata?: readonly ContextMember[];
  /** capability.tokenBudget.context */
  readonly budget: number;
  /** systemTokens + instructionTokens + tokenBudget.output */
  readonly reserve?: number;
  readonly countTokens?: (text: string) => number;
}

export interface AssembledContext {
  readonly text: string;
  readonly members: readonly AssembledMember[];
  readonly tokens: number;
}

const SHARES: readonly [ContextTier, number][] = [
  ['focus', 0.55],
  ['neighbours', 0.15],
  ['retrieval', 0.25],
  ['metadata', 0.05],
];

const TRUNCATION_MARK = '\n[…truncated…]\n';
/** Below this many tokens of room a truncated member would be all marker — skip instead. */
const MIN_TRUNCATED_TOKENS = 16;

export const estimateContextTokens = (text: string): number => Math.ceil((text.length / 4) * 1.15);

/** Head-tail truncate (§6.2): keep the opening and the end, mark the cut. */
function headTail(text: string, maxTokens: number, count: (text: string) => number): string {
  let keep = text.length;
  // Shrink by proportion until the estimate fits — precise enough for an estimator (≤ a few loops).
  let candidate = text;
  while (count(candidate) > maxTokens && keep > 8) {
    keep = Math.floor(keep * Math.min(0.9, maxTokens / count(candidate)));
    const head = Math.ceil(keep * 0.6);
    const tail = keep - head;
    candidate = text.slice(0, head) + TRUNCATION_MARK + (tail > 0 ? text.slice(-tail) : '');
  }
  return candidate;
}

export function assembleContext(options: AssembleOptions): AssembledContext {
  const count = options.countTokens ?? estimateContextTokens;
  const available = Math.max(0, options.budget - (options.reserve ?? 0));
  const lists: Record<ContextTier, readonly ContextMember[]> = {
    focus: options.focus,
    neighbours: options.neighbours ?? [],
    retrieval: options.retrieval ?? [],
    metadata: options.metadata ?? [],
  };

  const members: AssembledMember[] = [];
  let carry = 0;
  let tokens = 0;
  for (const [tier, share] of SHARES) {
    const allocation = Math.floor(available * share) + carry;
    let spent = 0;
    for (const member of lists[tier]) {
      const cost = count(member.text);
      const room = allocation - spent;
      if (cost <= room) {
        members.push({ id: member.id, tier, text: member.text, truncated: false });
        spent += cost;
      } else if (room >= MIN_TRUNCATED_TOKENS) {
        const text = headTail(member.text, room, count);
        members.push({ id: member.id, tier, text, truncated: true });
        spent += count(text);
        break; // The tier is full; whole-member order means the rest ranked lower anyway.
      } else {
        break;
      }
    }
    tokens += spent;
    carry = allocation - spent;
  }

  return { text: members.map((member) => member.text).join('\n\n'), members, tokens };
}
