/**
 * Generic inspector controls (P4 §5.6, §6). Fields are rendered from the registry's
 * `InspectorField[]` descriptors, so a new node type gets a working editor without a line of UI
 * code. Validation runs on blur and every message names the fix, never just "invalid".
 */

import type { InspectorField } from '@nexus/domain';
import { useEffect, useRef, useState } from 'react';

export interface FieldControlProps {
  field: InspectorField;
  value: unknown;
  disabled?: boolean;
  error?: string | undefined;
  /** Text controls only: focus and select the value on mount (a freshly created node). */
  focusOnMount?: boolean;
  /** Called on blur (text-ish controls) or immediately (select, toggle). */
  onCommit: (value: unknown) => void;
}

const asText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
};

/** Multi-value controls store arrays; the UI edits them as one line per value. */
const asLines = (value: unknown): string =>
  Array.isArray(value) ? value.map((item) => asText(item)).join('\n') : asText(value);

export function FieldControl({
  field,
  value,
  disabled = false,
  error,
  focusOnMount = false,
  onCommit,
}: FieldControlProps) {
  const initial = field.control === 'multiselect' ? asLines(value) : asText(value);
  const [draft, setDraft] = useState(initial);
  // Focus is claimed exactly once. Without this latch the ref callback below refocuses on every
  // render, which fights a modal's focus trap (Radix pulls focus back, we grab it again) and spins
  // React forever — that was the hang in BoardWorkspace's export test.
  const focusClaimed = useRef(false);

  // An untouched field must not write to the document. `updateNode` always sets the key and bumps
  // `updatedAt`, so a blur that commits the unchanged value still lands on the undo stack — and the
  // next ⌘Z (or Undo click, which blurs the field first) reverts that invisible edit instead of the
  // user's last real change. Committing only a changed draft keeps undo on real steps.
  const commit = (value: unknown): void => {
    if (draft === initial) return;
    onCommit(value);
  };

  // A remote edit (or an undo) must win over an untouched draft.
  useEffect(() => {
    setDraft(initial);
  }, [initial]);

  const id = `inspector-${field.key.replace(/\./g, '-')}`;
  const describedBy = [
    field.help === undefined ? null : `${id}-help`,
    error === undefined ? null : `${id}-error`,
  ]
    .filter((entry): entry is string => entry !== null)
    .join(' ');

  const common = {
    id,
    disabled,
    'aria-invalid': error === undefined ? undefined : true,
    ...(describedBy === '' ? {} : { 'aria-describedby': describedBy }),
  } as const;

  let control: React.ReactElement;
  if (field.control === 'readonly' || field.control === 'json') {
    control = (
      <pre className="nx-field-readonly" id={id} data-testid={`${id}-readonly`}>
        {field.control === 'json' ? JSON.stringify(value ?? null, null, 2) : asText(value) || '—'}
      </pre>
    );
  } else if (field.control === 'select') {
    control = (
      <select
        {...common}
        className="nx-input"
        value={asText(value)}
        onChange={(event) => onCommit(event.target.value)}
      >
        {(field.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  } else if (field.control === 'toggle') {
    control = (
      <input
        {...common}
        type="checkbox"
        checked={value === true}
        onChange={(event) => onCommit(event.target.checked)}
      />
    );
  } else if (field.control === 'textarea' || field.control === 'multiselect') {
    control = (
      <textarea
        {...common}
        className="nx-input"
        rows={field.control === 'multiselect' ? 3 : 4}
        value={draft}
        placeholder={field.placeholder ?? ''}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() =>
          commit(
            field.control === 'multiselect'
              ? draft
                  .split('\n')
                  .map((line) => line.trim())
                  .filter((line) => line !== '')
              : draft,
          )
        }
      />
    );
  } else {
    control = (
      <input
        {...common}
        className="nx-input"
        type={field.control === 'number' ? 'number' : field.control === 'email' ? 'email' : 'text'}
        value={draft}
        placeholder={field.placeholder ?? ''}
        ref={(element) => {
          // Focus once, on mount, for a node the user just created; `autoFocus` is banned by a11y lint.
          if (focusOnMount && element !== null && !focusClaimed.current) {
            focusClaimed.current = true;
            element.focus();
            element.select();
          }
        }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commit(field.control === 'number' ? Number(draft) : draft)}
        // Blur alone loses edits: clicking the canvas does not move focus out of the input, so a
        // typed title could vanish. Enter commits, Escape restores the stored value (P4 §5.6).
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit(field.control === 'number' ? Number(draft) : draft);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setDraft(initial);
          }
        }}
      />
    );
  }

  return (
    <div className="nx-field">
      <label className="nx-field-label" htmlFor={id}>
        {field.label}
        {field.required === true ? <span aria-hidden="true"> *</span> : null}
      </label>
      {control}
      {field.help === undefined ? null : (
        <p className="nx-field-help" id={`${id}-help`}>
          {field.help}
        </p>
      )}
      {error === undefined ? null : (
        <p className="nx-field-error" id={`${id}-error`} role="status">
          {error}
        </p>
      )}
    </div>
  );
}

/** Reads `data.url` / `title` / `type` out of a node, so descriptors stay declarative. */
export function readPath(node: Record<string, unknown>, path: string): unknown {
  let current: unknown = node;
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
