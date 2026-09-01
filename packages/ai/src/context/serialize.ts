/**
 * The context serializer (14_AI_AGENT.md §6.1): nodes render into a stable XML-ish form — lower
 * token cost than JSON for long text, and the tag boundaries make the "content is data" rule
 * visually enforceable in the prompt. Node ids are always real so citations validate (§7.2).
 */

import type { BoardNode } from '@nexus/domain';

/** `<` → `&lt;` inside text also neutralizes any literal `</node>` an adversarial page embeds. */
const escapeText = (text: string): string => text.replaceAll('<', '&lt;');

const escapeAttr = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

const BODY_KEYS = ['text', 'summary', 'description'] as const;

export function serializeNode(node: BoardNode): string {
  const attrs: [string, string][] = [
    ['id', node.id],
    ['type', node.type],
    ['title', node.title],
  ];
  const url = node.data['url'];
  if (typeof url === 'string' && url.length > 0) attrs.push(['url', url]);
  attrs.push(['observed', node.updatedAt.slice(0, 10)], ['confidence', node.confidence]);
  if (node.tags.length > 0) attrs.push(['tags', node.tags.join(',')]);

  const body = BODY_KEYS.map((key) => node.data[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n');
  const head = attrs.map(([key, value]) => `${key}="${escapeAttr(value)}"`).join(' ');
  return body.length === 0
    ? `<node ${head}></node>`
    : `<node ${head}>\n${escapeText(body)}\n</node>`;
}
