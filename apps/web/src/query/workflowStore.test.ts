import { WORKFLOW_TEMPLATES, type Workflow } from '@nexus/query-engine';
import { beforeEach, describe, expect, it } from 'vitest';

import { deleteWorkflow, listWorkflows, saveWorkflow } from './workflowStore.ts';

const template = WORKFLOW_TEMPLATES[0] as Workflow;

describe('workflowStore', () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  it('saves, lists and deletes', () => {
    expect(listWorkflows()).toEqual([]);
    saveWorkflow(template);
    expect(listWorkflows()[0]?.workflow).toEqual(template);
    deleteWorkflow(template.id);
    expect(listWorkflows()).toEqual([]);
  });

  it('replaces a workflow instead of keeping two versions of it', () => {
    saveWorkflow(template);
    saveWorkflow({ ...template, name: 'Renamed' });
    const entries = listWorkflows();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.workflow.name).toBe('Renamed');
  });

  it('drops a corrupted entry instead of loading half of it', () => {
    globalThis.localStorage.setItem(
      'raven.workflows.v1',
      JSON.stringify([{ workflow: { id: 'x' }, savedAt: 'now' }]),
    );
    expect(listWorkflows()).toEqual([]);
    globalThis.localStorage.setItem('raven.workflows.v1', 'not json');
    expect(listWorkflows()).toEqual([]);
  });
});
