/**
 * The board surface plus everything around it that P3 owns: document ⇄ canvas binding, the save
 * indicator, undo/redo, snapshots and export/import.
 *
 * The engine is created once; document changes reach it as incremental patches, never as a
 * re-render (P3 §7).
 */

import {
  countEntities,
  deleteNode,
  duplicateNode,
  exportBoard,
  importBoard,
  listEdges,
  listNodes,
  newId,
  nodeBudget,
  observeBoard,
  serializeBoardExport,
  NODE_SOFT_LIMIT,
  type ClipSource,
} from '@nexus/domain';
import { Banner, Button } from '@nexus/ui';
import type { Engine, Intent } from '@nexus/canvas-engine';
import type { CSSProperties } from 'react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import { useBoardDoc } from '../../data/docProvider.tsx';
import { useReportBoardCounts, useTouchBoardOpened } from '../../data/workspace/context.tsx';
import { restoreSnapshot } from '../../data/snapshots.ts';
import { useBoardSearchIndex } from '../../search/useBoardSearchIndex.ts';
import { CanvasHost } from '../canvas/CanvasHost';
import { useViewportMemory } from '../canvas/useViewportMemory.ts';
import { VIEW_LABELS, VIEW_MODES, type ViewMode } from '../../views/projections.ts';
import { applyIntent, connectToEmpty, createNoteNode } from '../canvas/bindings/applyIntents.ts';
import { EdgeLayer, pendingFromIntent, type PendingEdgeUi } from '../../edges/EdgeLayer.tsx';
import { BoardInspector } from './BoardInspector.tsx';
import { patchesFromChange, sceneFromDoc } from '../canvas/bindings/sceneFromDoc.ts';
import { NodeHosts } from '../../nodes/NodeHosts.tsx';
import { createNodeStore } from '../../nodes/nodeStore.ts';
import { SyncStatus } from '../shell/SyncStatus.tsx';
import { useBoardStatus } from '../shell/boardStatus.tsx';
import type { ImportPreview } from './ImportDialog.tsx';
import { QuickAdd } from '../../capture/QuickAdd.tsx';
import { PasteToast } from '../../capture/PasteToast.tsx';
import { captureTransfer, usePaste, type CaptureResult } from '../../capture/usePaste.ts';
import { useDropZone } from '../../capture/useDropZone.ts';
import { useCopyCut } from '../../capture/useCopyCut.ts';
import { GroupsPanel } from './GroupsPanel.tsx';
import { groupSelected, ungroupSelected } from './groupCommands.ts';

import { useRegisterCommands } from '../commands/useRegisterCommands.ts';
import { AutoArrangePanel } from '../../layout/AutoArrangePanel.tsx';
import { LayoutGhosts } from '../../layout/LayoutGhosts.tsx';
import { useAutoArrangeStore } from '../../layout/autoArrangeStore.ts';
import { capabilities } from '../../mode/appMode';

// Panels that only exist once the user opens them, so their code (and their dependencies) stays
// out of the board's first paint (§23 lazy loading). Each is rendered only while open, which is
// also what keeps the chunk from being fetched at all on a board nobody opens a panel on.
const VersionHistory = lazy(async () => ({
  default: (await import('./VersionHistory.tsx')).VersionHistory,
}));
const AIPanel = lazy(async () => ({ default: (await import('../../ai/AIPanel.tsx')).AIPanel }));
const IntegrationsSurface = lazy(async () => ({
  default: (await import('../../integrations/IntegrationsSurface.tsx')).IntegrationsSurface,
}));
const PresentationMode = lazy(async () => ({
  default: (await import('../../presentation/PresentationMode.tsx')).PresentationMode,
}));

const ViewPanel = lazy(async () => ({
  default: (await import('../../views/ViewPanel.tsx')).ViewPanel,
}));

const ExportDialog = lazy(async () => ({
  default: (await import('../../export/ExportDialog.tsx')).ExportDialog,
}));

const ImportDialog = lazy(async () => ({
  default: (await import('./ImportDialog.tsx')).ImportDialog,
}));

const APP_VERSION = '0.3.0';

export function BoardWorkspace() {
  const { boardId, doc, history, status, snapshots, snapshotStore, ready, storageWarning, retry } =
    useBoardDoc();
  const [engine, setEngine] = useState<Engine | null>(null);
  const onEngine = useCallback((next: Engine | null) => setEngine(next), []);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('canvas');
  const [presenting, setPresenting] = useState(false);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [budgetWarning, setBudgetWarning] = useState(false);
  const [counts, setCounts] = useState({ nodes: 0, edges: 0 });
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [inspectorWidth, setInspectorWidth] = useState(360);
  const [focusTitleFor, setFocusTitleFor] = useState<string | undefined>(undefined);
  // Absent, not disabled, when the capability is off (ADR-002, N2): nothing below renders.
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);

  // Auto Arrange is ephemeral UI state, never document state (P14a, N2).
  const arrangeOpen = useAutoArrangeStore((state) => state.open);
  const arrangeDiff = useAutoArrangeStore((state) => state.diff);
  const setArrangeOpen = useAutoArrangeStore((state) => state.setOpen);
  /** Both panels dock into the same top-right corner, so only one of them is ever open. */
  const openGroups = useCallback(
    (open: boolean) => {
      setGroupsOpen(open);
      if (open) setArrangeOpen(false);
    },
    [setArrangeOpen],
  );
  const openArrange = useCallback(
    (open: boolean) => {
      setArrangeOpen(open);
      if (open) setGroupsOpen(false);
    },
    [setArrangeOpen],
  );

  const boardStatus = useBoardStatus();
  const [capture, setCapture] = useState<CaptureResult | null>(null);
  const searchIndex = useBoardSearchIndex(doc, boardId);
  const touchOpened = useTouchBoardOpened();
  const reportCounts = useReportBoardCounts();
  const location = useLocation();
  // `/p/:projectId/b/:boardId` carries it; the bare `/b/:boardId` route does not, and the server
  // then refuses the run rather than guessing a project (§7.1 preconditions).
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const slotOfRef = useRef<(id: string) => HTMLElement | undefined>(() => undefined);
  const focusedOnceRef = useRef<string | null>(null);

  // Capture aims at the middle of what the analyst is looking at; the pointer position is only
  // known inside the engine, so a drop re-aims through `screenToWorld` below.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const aim = useCallback(() => {
    const screen = pointer.current;
    if (screen !== null && engine !== null) return engine.camera.screenToWorld(screen);
    const viewport = engine?.camera.viewportWorld;
    return viewport === undefined
      ? { x: 0, y: 0 }
      : { x: viewport.x + viewport.w / 2, y: viewport.y + viewport.h / 2 };
  }, [engine]);
  // Identity of this board travels with copy/paste so a clip pasted into another board (or
  // project) keeps a `Referenced from` back-link instead of losing where it came from (§20).
  const clipSource = useMemo(
    (): ClipSource => (projectId === '' ? { boardId } : { boardId, projectId }),
    [boardId, projectId],
  );
  const captureTarget = useMemo(
    () => ({ doc, history, aim, into: clipSource }),
    [doc, history, aim, clipSource],
  );

  usePaste(captureTarget, setCapture);
  // Ctrl+C / Ctrl+X over the canvas (§18); the selection lives in the engine, never in the doc.
  const selectedIdsRef = useRef<readonly string[]>([]);
  selectedIdsRef.current = selectedIds;
  const copyTarget = useMemo(
    () => ({ doc, history, selection: () => selectedIdsRef.current, source: clipSource }),
    [doc, history, clipSource],
  );
  useCopyCut(copyTarget, setNotice);
  const dropZone = useDropZone(captureTarget, setCapture);

  // One store per document: cards subscribe per node id, so an edit re-renders one card (P4 §7).
  const store = useMemo(() => createNodeStore(doc), [doc]);
  useEffect(() => () => store.destroy(), [store]);

  const now = useCallback(() => new Date().toISOString(), []);
  const report = useCallback((message: string) => setNotice(message), []);
  const context = { doc, history, now, makeId: (): string => newId.board(), onNotice: report };
  const intentContext = useCallback(
    () => ({
      doc,
      history,
      now,
      makeId: (): string => newId.board(),
      onNotice: report,
      onEdgeCreated: (edgeId: string): void => setSelectedIds([edgeId]),
    }),
    [doc, history, now, report],
  );
  // The relationship menus open at a world point; the screen position is only available inside the
  // canvas render prop, so the intent handler stores world coordinates and `EdgeLayer` converts.
  const [pendingMenu, setPendingMenu] = useState<PendingEdgeUi | null>(null);

  const onIntent = useCallback(
    (intent: Intent) => {
      const pending = pendingFromIntent(intent);
      if (pending !== null) {
        setPendingMenu(pending);
        return;
      }
      applyIntent(intent, intentContext());
    },
    [intentContext],
  );

  // Document → engine: incremental patches, O(changed) per transaction.
  useEffect(() => {
    if (!ready || engine === null) return undefined;
    const scene = sceneFromDoc(doc);
    engine.applyScenePatch({ op: 'set-layers', layers: scene.layers });
    for (const node of scene.nodes) engine.applyScenePatch({ op: 'upsert-node', node });
    for (const edge of scene.edges) engine.applyScenePatch({ op: 'upsert-edge', edge });
    setCounts({ nodes: countEntities(doc).nodes, edges: countEntities(doc).edges });

    return observeBoard(doc, (change) => {
      const patches = patchesFromChange(doc, change);
      if (patches.length === 0) return;
      engine.applyScenePatch({ op: 'bulk', patches });
      setBudgetWarning(nodeBudget(doc).warn);
      setCounts({ nodes: countEntities(doc).nodes, edges: countEntities(doc).edges });
    });
  }, [doc, ready, engine]);

  // Reopening a board lands where the analyst left off (§5.7); runs after the first scene patch.
  useViewportMemory(engine, boardId, ready);

  // The status bar belongs to the shell but the numbers belong here (see shell/boardStatus).
  useEffect(() => {
    boardStatus.publish({ counts, tags: [...new Set(listNodes(doc).flatMap((n) => n.tags))] });
    // Denormalized counters (P7 §5.1): the client reports what it just saved; local/server clamp.
    reportCounts(boardId, counts.nodes, counts.edges);
    // `publish` is stable enough for this: it de-duplicates identical values itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counts.nodes, counts.edges]);

  // The board's search index (P7 §5) and the camera-jump-and-pulse the palette/search use.
  const focusNode = useCallback(
    (nodeId: string) => {
      if (engine === null) return;
      engine.camera.focus(nodeId);
      engine.selection.set([nodeId]);
      const el = slotOfRef.current(nodeId);
      if (el === undefined) return;
      el.classList.add('nx-search-pulse');
      window.setTimeout(() => el.classList.remove('nx-search-pulse'), 1200);
    },
    [engine],
  );
  useEffect(() => {
    boardStatus.publish({ boardId, searchIndex, focusNode });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, searchIndex, focusNode]);

  // Records "opened" once per mount (P7 §6: board grid's "last opened" sort).
  useEffect(() => {
    void touchOpened(boardId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId]);

  // A search result or palette "@" pick can arrive as router state: jump to it once, on arrival.
  useEffect(() => {
    const state = location.state as { focusNodeId?: string } | null;
    const target = state?.focusNodeId;
    if (target === undefined || target === focusedOnceRef.current || engine === null) return;
    focusedOnceRef.current = target;
    focusNode(target);
    void navigate(location.pathname, { replace: true, state: null });
  }, [location, engine, focusNode, navigate]);

  // Selection lives in the engine (it is per-user state, never in the CRDT); the panel mirrors it.
  useEffect(() => {
    if (engine === null) return undefined;
    return engine.on('selectionChanged', (ids) => setSelectedIds([...ids]));
  }, [engine]);

  // Undo/redo shortcuts (P3 §5.5).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || event.key.toLowerCase() !== 'z') return;
      event.preventDefault();
      if (event.shiftKey) history.redo();
      else history.undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [history]);

  // Second entry point (§7.1): the P7 command palette. Registered only where the surface exists.
  useRegisterCommands([
    {
      id: 'board.autoArrange',
      title: 'Auto arrange…',
      group: 'board' as const,
      keywords: ['layout', 'arrange', 'tidy', 'organise', 'organize', 'graph'],
      shortcut: 'Ctrl+Alt+R',
      when: (ctx: { view: string }) => ctx.view === 'board',
      run: () => openArrange(true),
    },
  ]);

  // `Ctrl/⌘+Alt+R` — the canvas view keymap (03_UX.md §15.4).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || !event.altKey) return;
      if (event.key.toLowerCase() !== 'r') return;
      event.preventDefault();
      openArrange(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openArrange]);

  useRegisterCommands(
    capabilities.integrations
      ? [
          {
            id: 'integrations.run',
            title: 'Run integration…',
            group: 'board' as const,
            keywords: ['tool', 'run', 'enrich'],
            when: (ctx: { view: string }) => ctx.view === 'board',
            run: () => setIntegrationsOpen(true),
          },
        ]
      : [],
  );

  // Group / ungroup the selection (§19); the rules live in `groupCommands` (testable without a canvas).
  const groupContext = useCallback(() => ({ doc, history, now }), [doc, history, now]);
  const onGroup = useCallback(
    () => setNotice(groupSelected(groupContext(), selectedIds)),
    [groupContext, selectedIds],
  );
  const onUngroup = useCallback(
    () => setNotice(ungroupSelected(groupContext(), selectedIds)),
    [groupContext, selectedIds],
  );

  useRegisterCommands(
    useMemo(
      () => [
        {
          id: 'board.group',
          title: 'Group selection',
          group: 'board' as const,
          keywords: ['group', 'cluster', 'frame', 'investigation'],
          shortcut: 'Ctrl+G',
          when: (ctx: { view: string }) => ctx.view === 'board',
          run: onGroup,
        },
        {
          id: 'ai.assistant',
          title: 'AI assistant…',
          group: 'board' as const,
          keywords: ['ai', 'summarise', 'duplicates', 'suggest', 'cluster'],
          when: (ctx: { view: string }) => ctx.view === 'board',
          run: () => setAiOpen(true),
        },
        {
          id: 'board.groups',
          title: 'Groups…',
          group: 'board' as const,
          keywords: ['groups', 'clusters', 'frames', 'collapse', 'lock'],
          when: (ctx: { view: string }) => ctx.view === 'board',
          run: () => openGroups(true),
        },
        {
          id: 'board.ungroup',
          title: 'Ungroup selection',
          group: 'board' as const,
          keywords: ['ungroup', 'split', 'frame'],
          shortcut: 'Ctrl+Shift+G',
          when: (ctx: { view: string }) => ctx.view === 'board',
          run: onUngroup,
        },
      ],
      [onGroup, onUngroup],
    ),
  );

  // `Ctrl/⌘+G` and `Ctrl/⌘+Shift+G` — the canvas view keymap (03_UX.md §15.4).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key.toLowerCase() !== 'g') return;
      event.preventDefault();
      if (event.shiftKey) onUngroup();
      else onGroup();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onGroup, onUngroup]);

  const addNote = useCallback(() => {
    if (nodeBudget(doc).blocked) {
      setNotice('This board is full. Split the investigation into a second board.');
      return;
    }
    // Drop the note in the middle of what the user is looking at, not at the world origin.
    const viewport = engine?.camera.viewportWorld;
    const at =
      viewport === undefined
        ? { x: 0, y: 0 }
        : { x: viewport.x + viewport.w / 2, y: viewport.y + viewport.h / 2 };
    // Select the new note and focus its title: typing must land in the field, not in the
    // single-key board shortcuts (§36).
    const id = createNoteNode(context, at);
    setSelectedIds([id]);
    setFocusTitleFor(id);
    // `context` is rebuilt every render on purpose: it only holds the doc, history and clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, history, engine]);

  const importAsList = useCallback(() => {
    if (capture === null) return;
    setCapture(captureTransfer(captureTarget, capture.snapshot, 'paste', { asList: true }));
  }, [capture, captureTarget]);

  const quickCapture = useCallback(
    (text: string) => setCapture(captureTransfer(captureTarget, { text }, 'quick-add')),
    [captureTarget],
  );

  const finishDrop = useCallback(
    (from: string, at: { x: number; y: number }) => {
      connectToEmpty(intentContext(), from, at);
      setPendingMenu(null);
    },
    [intentContext],
  );

  const download = useCallback(() => {
    const archive = exportBoard(doc, { appVersion: APP_VERSION, now: new Date().toISOString() });
    const blob = new Blob([serializeBoardExport(archive)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${archive.board.title || 'board'}.raven.json`;
    link.click();
    URL.revokeObjectURL(url);
  }, [doc]);

  const buildArchive = useCallback(
    () => exportBoard(doc, { appVersion: APP_VERSION, now: new Date().toISOString() }),
    [doc],
  );

  const confirmImport = useCallback(
    (preview: ImportPreview) => {
      // An import is preceded by a checkpoint, so one undo (or one restore) reverses it.
      void snapshots.capture('pre-import');
      const { report } = importBoard(preview.data, {
        mode: 'merge-into',
        into: doc,
        newId: () => newId.board(),
        now: new Date().toISOString(),
      });
      setImportOpen(false);
      setNotice(
        `Imported ${String(report.created.nodes)} nodes and ${String(report.created.edges)} edges.` +
          (report.warnings.length > 0 ? ` ${report.warnings[0] ?? ''}` : ''),
      );
    },
    [doc, snapshots],
  );

  const restore = useCallback(
    (id: string) => {
      void snapshotStore.load(id).then((record) => {
        if (record === null) return;
        restoreSnapshot(doc, record);
        setPreviewing(null);
        setHistoryOpen(false);
        setNotice('Version restored. Press ⌘Z to undo the restore.');
      });
    },
    [doc, snapshotStore],
  );

  return (
    <section
      className="nx-board"
      aria-label="Board"
      style={{ '--nx-inspector-width': `${String(inspectorWidth)}px` } as CSSProperties}
    >
      <header className="nx-board-bar">
        <Button onClick={addNote} data-testid="add-note">
          Add note
        </Button>
        <QuickAdd onNote={addNote} onCapture={quickCapture} />
        <Button
          variant="secondary"
          onClick={() => openArrange(!arrangeOpen)}
          aria-expanded={arrangeOpen}
          data-testid="auto-arrange-open"
        >
          Auto arrange
        </Button>
        <Button
          variant="secondary"
          onClick={() => openGroups(!groupsOpen)}
          aria-expanded={groupsOpen}
          data-testid="groups-open"
        >
          Groups
        </Button>
        <Button variant="secondary" onClick={() => setHistoryOpen(true)}>
          Version history
        </Button>
        <label className="nx-inline">
          <span className="nx-visually-hidden">View mode</span>
          <select
            data-testid="view-mode"
            value={viewMode}
            onChange={(event) => setViewMode(event.target.value as ViewMode)}
          >
            {VIEW_MODES.map((value) => (
              <option key={value} value={value}>
                {VIEW_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <Button variant="secondary" onClick={() => setPresenting(true)}>
          Present
        </Button>
        <Button variant="secondary" onClick={() => setExportOpen(true)}>
          Export
        </Button>
        <Button variant="secondary" onClick={() => setImportOpen(true)}>
          Import
        </Button>
        <span className="nx-muted" data-testid="node-count" data-nodes={String(counts.nodes)}>
          {String(counts.nodes)} nodes · {String(counts.edges)} edges
        </span>
        <SyncStatus status={status} history={history} onRetry={() => retry()} onExport={download} />
      </header>

      {storageWarning !== null ? (
        <Banner kind="warn" title="Storage is limited on this device">
          {storageWarning}
        </Banner>
      ) : null}
      {budgetWarning ? (
        <Banner kind="warn" title="This board is getting large">
          Past {String(NODE_SOFT_LIMIT)} nodes the canvas slows down. Consider splitting it.
        </Banner>
      ) : null}
      {notice !== null ? (
        <Banner kind="info" title="Board updated">
          {notice}
        </Banner>
      ) : null}

      <div
        className="nx-board-main"
        onDragOver={dropZone.handlers.onDragOver}
        onDragLeave={dropZone.handlers.onDragLeave}
        onDrop={dropZone.handlers.onDrop}
        onPointerMove={(event) => {
          pointer.current = { x: event.clientX, y: event.clientY };
        }}
      >
        {dropZone.state.active ? (
          <div className="nx-drop-overlay" data-testid="drop-overlay" aria-hidden="true">
            <span>Drop to add {dropZone.state.summary}</span>
          </div>
        ) : null}
        {viewMode === 'canvas' ? null : (
          <Suspense fallback={null}>
            <ViewPanel
              mode={viewMode}
              nodes={listNodes(doc)}
              edges={listEdges(doc)}
              onSelect={(id) => setSelectedIds([id])}
            />
          </Suspense>
        )}
        <CanvasHost
          onIntent={onIntent}
          onEngine={onEngine}
          nodeCount={counts.nodes}
          inert={viewMode !== 'canvas'}
        >
          {({ slotOf, screenOf }) => {
            slotOfRef.current = slotOf;
            return (
              <>
                <NodeHosts
                  engine={engine}
                  doc={doc}
                  store={store}
                  slotOf={slotOf}
                  selectedIds={selectedIds}
                  onOpenInspector={(id) => setSelectedIds([id])}
                  onDuplicate={(id) => {
                    duplicateNode(doc, id, { now: new Date().toISOString() });
                  }}
                  onDelete={(id) => {
                    deleteNode(doc, id, { now: new Date().toISOString() });
                  }}
                  onRunIntegration={
                    capabilities.integrations
                      ? (id) => {
                          setSelectedIds([id]);
                          setIntegrationsOpen(true);
                        }
                      : undefined
                  }
                />
                <LayoutGhosts engine={engine} diff={arrangeDiff} />
                <EdgeLayer
                  doc={doc}
                  context={context}
                  pending={pendingMenu}
                  screenOf={screenOf}
                  onClose={() => setPendingMenu(null)}
                  onConnectToEmpty={finishDrop}
                  onEditLabel={(id) => setSelectedIds([id])}
                  onResult={(result) => {
                    if (result.message !== null) setNotice(result.message);
                  }}
                />
              </>
            );
          }}
        </CanvasHost>

        <BoardInspector
          doc={doc}
          store={store}
          selectedIds={selectedIds}
          context={context}
          width={inspectorWidth}
          onWidthChange={setInspectorWidth}
          onClose={() => setSelectedIds([])}
          onEdgeDeleted={() => setSelectedIds([])}
          focusTitleFor={focusTitleFor}
        />
      </div>

      <PasteToast
        message={capture?.message ?? null}
        onUndo={
          capture !== null && capture.ids.length > 0
            ? () => {
                history.undo();
                setCapture(null);
              }
            : null
        }
        onImportList={capture !== null && capture.overflow !== null ? importAsList : null}
        onDismiss={() => setCapture(null)}
      />

      <Suspense fallback={null}>
        {historyOpen ? (
          <VersionHistory
            open={historyOpen}
            boardId={boardId}
            store={snapshotStore}
            onOpenChange={setHistoryOpen}
            onPreview={setPreviewing}
            onRestore={restore}
            previewingId={previewing}
          />
        ) : null}
        {aiOpen ? (
          <AIPanel
            open={aiOpen}
            onClose={() => setAiOpen(false)}
            doc={doc}
            boardId={boardId}
            selectedIds={selectedIds}
            onUndo={() => history.undo()}
          />
        ) : null}
        {capabilities.integrations && integrationsOpen ? (
          <IntegrationsSurface
            open={integrationsOpen}
            onClose={() => setIntegrationsOpen(false)}
            doc={doc}
            boardId={boardId}
            projectId={projectId}
            selection={selectedIds.map((id) => {
              const found = listNodes(doc).find((node) => node.id === id);
              return { id, kind: found?.type ?? 'note', label: found?.title ?? '' };
            })}
            onUndo={() => history.undo()}
          />
        ) : null}
        {presenting ? (
          <PresentationMode
            open={presenting}
            nodes={listNodes(doc)}
            edges={listEdges(doc)}
            selectedIds={selectedIds}
            onClose={() => setPresenting(false)}
            onFocus={(ids) => {
              if (ids.length > 0) setSelectedIds([...ids]);
            }}
          />
        ) : null}
        {exportOpen ? (
          <ExportDialog
            open={exportOpen}
            onOpenChange={setExportOpen}
            buildArchive={buildArchive}
            canvas={() => document.querySelector('canvas')}
          />
        ) : null}
        {importOpen ? (
          <ImportDialog open={importOpen} onOpenChange={setImportOpen} onConfirm={confirmImport} />
        ) : null}
      </Suspense>

      <GroupsPanel
        open={groupsOpen}
        doc={doc}
        context={groupContext()}
        onClose={() => openGroups(false)}
        onSelect={(ids) => setSelectedIds([...ids])}
        onNotice={setNotice}
      />

      <AutoArrangePanel
        doc={doc}
        history={history}
        selectedIds={selectedIds}
        onApplied={(count) =>
          setNotice(`Auto arrange moved ${String(count)} nodes. Press ⌘Z to undo it in one step.`)
        }
      />
    </section>
  );
}
