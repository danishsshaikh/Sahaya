'use client';

import { useEffect, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import type { VisualizationContent, VisualizationOptions } from '@openmaic/dsl';
import type { Scene } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';
import type { SceneEditorSurface } from '@/lib/edit/scene-editor-surface';
import { sceneEditorRegistry } from '@/lib/edit/scene-editor-registry';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { VisualizationOptionsFields } from '@/components/visualization/options';
import { VisualizationRenderer } from '@/components/scene-renderers/visualization-renderer';
import { flushStageSave, useStageStore } from '@/lib/store/stage';
import { changeOutlineType } from '@/lib/generation/outline-type';
import { getGenerationSceneTypeOptions } from '@/lib/generation/scene-type-options';
import {
  fetchSceneContent,
  fetchSceneActions,
  commitSceneAttempt,
  generateTTSForScene,
  removeFreshTtsAllocations,
  retimeVisualizationForNarration,
} from '@/lib/hooks/use-scene-generator';
import type { VisualizationRevision } from '@/lib/visualization/generate';
import { useVisualizationCapability } from '@/lib/visualization/client';

type VisualizationScene = Extract<Scene, { type: 'visualization' }>;
const PHASES: Record<string, string> = {
  planning: 'Planning animation',
  validating: 'Validating the plan',
  rendering: 'Rendering frames',
  processing: 'Checking video and poster',
  completed: 'Preparing narration cues',
  queued: 'Waiting for a renderer',
};
const REPLACEMENT_LABELS = {
  slide: 'Slide',
  quiz: 'Quiz',
  interactive: 'Simulation',
  pbl: 'Project',
  visualization: 'Visualization',
};
const EMPTY: ReturnType<SceneEditorSurface['useSurfaceState']> = {
  content: {} as VisualizationContent,
  selection: undefined,
  hasSelection: false,
  insertItems: [],
  floatingActions: [],
  hints: [],
  commands: [],
};

function Editor({ scene }: { scene: VisualizationScene }) {
  const capability = useVisualizationCapability();
  const [title, setTitle] = useState(scene.title);
  const [options, setOptions] = useState<VisualizationOptions>(scene.content.options ?? {});
  const [parameters, setParameters] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<VisualizationScene>();
  const [target, setTarget] = useState<SceneOutline['type']>('visualization');
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  const playable = preview ?? scene;
  useEffect(() => () => active.current?.abort(), []);

  async function generate(previewOnly: boolean) {
    if (active.current || !title.trim()) return;
    const state = useStageStore.getState();
    const stage = state.stage;
    if (!stage || stage.id !== scene.stageId) return;
    const source = state.getSceneById(scene.id);
    if (!source || source.type !== 'visualization') return;
    const controller = new AbortController();
    active.current = controller;
    const { signal } = controller;
    const freshAudioIds: string[] = [];
    let applied = false;

    setPhase('Preparing generation');
    setError('');
    try {
      const existing = state.outlines.find((item) => item.id === source.outlineId);
      const base: SceneOutline = {
        id: source.outlineId ?? source.id,
        title: title.trim(),
        order: source.order,
        description: options.instructions || existing?.description || source.title,
        keyPoints: existing?.keyPoints ?? [],
        teachingObjective: existing?.teachingObjective,
        type: 'visualization',
        visualization: options,
      };
      const outline = changeOutlineType(base, target);
      const allOutlines = state.outlines.some((item) => item.id === outline.id)
        ? state.outlines.map((item) => (item.id === outline.id ? outline : item))
        : [...state.outlines, outline].sort((a, b) => a.order - b.order);
      const numeric = Object.fromEntries(
        Object.entries(parameters).map(([key, input]) => {
          if (!input.trim() || !Number.isFinite(Number(input)))
            throw new Error('Enter a valid number for each scientific parameter.');
          return [key, Number(input)];
        }),
      );
      const updatedParameters = Object.keys(numeric).length > 0;
      const revision: VisualizationRevision = {
        requestKey: nanoid(),
        preview: previewOnly,
        ...(!previewOnly && preview
          ? { sourceArtifactId: preview.content.artifact.artifactId }
          : updatedParameters
            ? { sourceArtifactId: source.content.artifact.artifactId, parameters: numeric }
            : {}),
      };
      const result = await fetchSceneContent(
        {
          outline,
          allOutlines,
          stageId: stage.id,
          stageInfo: { name: stage.name },
          languageDirective: stage.lessonLanguage,
          visualizationRevision: revision,
        },
        signal,
        undefined,
        (status, position) =>
          setPhase(
            position
              ? `Waiting for a renderer · position ${position}`
              : (PHASES[status] ?? 'Generating scene'),
          ),
      );
      if (!result.success || !result.content || !result.attemptId || !result.generationVersion) {
        throw new Error(result.error || 'Scene generation failed.');
      }
      const identity = { attemptId: result.attemptId, generationVersion: result.generationVersion };
      const built = await fetchSceneActions(
        {
          outline: result.effectiveOutline ?? outline,
          allOutlines,
          stageId: stage.id,
          content: result.content,
          languageDirective: stage.lessonLanguage,
          ...identity,
        },
        signal,
      );
      if (!built.success || !built.scene)
        throw new Error(built.error || 'Could not prepare the scene.');
      signal.throwIfAborted();
      if (previewOnly && built.scene.type === 'visualization') {
        setPreview(built.scene);
        return;
      }

      const replacement = { ...built.scene, id: scene.id, order: source.order };
      const previousActions = new Map(source.actions?.map((action) => [action.id, action]));
      replacement.actions = (replacement.actions ?? []).map((action) => {
        const previous = previousActions.get(action.id);
        return action.type === 'speech' &&
          previous?.type === 'speech' &&
          action.text === previous.text &&
          !previous.audioInvalidated
          ? previous
          : action;
      });
      setPhase('Preparing Teaching Voice narration');
      const reusedIds = new Set(
        (replacement.actions ?? []).flatMap((action) =>
          action.type === 'speech' && action.audioId ? [action.audioId] : [],
        ),
      );
      const narration = await generateTTSForScene(
        replacement,
        stage.lessonLanguage,
        signal,
        undefined,
        undefined,
        outline.id,
        { skipReadyActions: true, allocationNamespace: revision.requestKey },
      );
      for (const action of replacement.actions ?? []) {
        if (action.type === 'speech' && action.audioId && !reusedIds.has(action.audioId))
          freshAudioIds.push(action.audioId);
      }
      if (!narration.success) throw new Error(narration.error || 'Narration synthesis failed.');
      if (replacement.type === 'visualization') {
        setPhase('Aligning animation with the recorded narration');
        replacement.content = await retimeVisualizationForNarration(
          replacement,
          outline,
          allOutlines,
          signal,
        );
      }
      signal.throwIfAborted();
      const committed = await commitSceneAttempt({
        ...identity,
        stageId: stage.id,
        outlineId: outline.id,
        sceneId: built.scene.id,
      });
      if (!committed.success)
        throw new Error(committed.error || 'This generation attempt expired. Try again.');
      signal.throwIfAborted();
      const latest = useStageStore.getState();
      if (latest.stage?.id !== stage.id || latest.getSceneById(scene.id) !== source) {
        throw new Error(
          'The scene changed during generation. Open the current version and try again.',
        );
      }
      latest.updateScene(scene.id, {
        type: replacement.type,
        content: replacement.content,
        title: replacement.title,
        outlineId: outline.id,
        actions: replacement.actions,
        updatedAt: Date.now(),
        narrationStatus: 'completed',
        narrationError: undefined,
        sync: undefined,
      });
      applied = true;
      latest.setOutlines(
        latest.outlines.some((item) => item.id === outline.id)
          ? latest.outlines.map((item) => (item.id === outline.id ? outline : item))
          : [...latest.outlines, outline].sort((a, b) => a.order - b.order),
      );
      setParameters({});
      setPreview(undefined);
      await flushStageSave();
    } catch (caught) {
      if (!signal.aborted)
        setError(caught instanceof Error ? caught.message : 'Scene generation failed.');
    } finally {
      if (!applied) await removeFreshTtsAllocations(freshAudioIds);
      if (active.current === controller) {
        active.current = null;
        if (!signal.aborted || useStageStore.getState().currentSceneId === scene.id) setPhase('');
      }
    }
  }

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto grid max-w-5xl gap-4">
        <div className="aspect-video overflow-hidden rounded-lg">
          <VisualizationRenderer key={playable.content.artifact.artifactId} scene={playable} />
        </div>
        <p className="text-xs text-muted-foreground">
          {preview ? 'Preview · ' : ''}
          {playable.content.artifact.classification === 'verified-components'
            ? 'Uses verified calculations. Review the explanation and labels.'
            : 'Illustrative animation'}
        </p>
        <fieldset className="grid gap-3" disabled={!!phase}>
          <label className="grid gap-1 text-xs font-medium">
            Scene title
            <Input
              value={title}
              maxLength={180}
              onChange={(event) => {
                setTitle(event.target.value);
                setPreview(undefined);
              }}
            />
          </label>
          <label className="grid gap-1 text-xs font-medium">
            Scene type
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              value={target}
              onChange={(event) => {
                setTarget(event.target.value as SceneOutline['type']);
                setPreview(undefined);
              }}
            >
              <option value="visualization">Visualization</option>
              {getGenerationSceneTypeOptions().map((type) => (
                <option key={type} value={type}>
                  {REPLACEMENT_LABELS[type]}
                </option>
              ))}
            </select>
          </label>
          {target === 'visualization' && (
            <>
              <VisualizationOptionsFields
                value={options}
                onChange={(value) => {
                  setOptions(value);
                  setPreview(undefined);
                }}
              />
              {scene.content.model && (
                <details className="rounded-md border p-3 text-sm">
                  <summary className="cursor-pointer font-medium">Scientific parameters</summary>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {Object.entries(scene.content.model).map(([key, value]) => (
                      <label key={key} className="grid gap-1 text-xs font-medium">
                        {key}
                        {typeof value === 'number' ? (
                          <Input
                            type="number"
                            step="any"
                            value={parameters[key] ?? value}
                            onChange={(event) => {
                              setParameters({ ...parameters, [key]: event.target.value });
                              setPreview(undefined);
                            }}
                          />
                        ) : (
                          <span className="text-sm font-normal">
                            {Array.isArray(value) ? value.join(', ') : value}
                          </span>
                        )}
                      </label>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}
        </fieldset>
        {target === 'visualization' && capability?.available === false && (
          <p className="text-sm text-muted-foreground">{capability.reason}</p>
        )}
        {phase && (
          <p role="status" className="text-sm">
            {phase}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {target === 'visualization' && (
            <Button
              type="button"
              variant="outline"
              disabled={!!phase || !title.trim() || !capability?.available}
              onClick={() => void generate(true)}
            >
              Render preview
            </Button>
          )}
          <Button
            type="button"
            disabled={
              !!phase || !title.trim() || (target === 'visualization' && !capability?.available)
            }
            onClick={() => void generate(false)}
          >
            {target !== 'visualization'
              ? 'Replace scene'
              : preview
                ? 'Apply preview as final'
                : 'Regenerate visualization'}
          </Button>
          {phase && (
            <Button type="button" variant="ghost" onClick={() => active.current?.abort()}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Surface() {
  const currentId = useStageStore.use.currentSceneId();
  const scene = useStageStore((state) => state.scenes.find((item) => item.id === currentId));
  return scene?.type === 'visualization' ? (
    <Editor key={scene.id + scene.content.artifact.artifactId} scene={scene} />
  ) : null;
}

sceneEditorRegistry.register({
  sceneType: 'visualization',
  SurfaceComponent: Surface,
  useSurfaceState: () => EMPTY,
});
