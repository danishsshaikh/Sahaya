'use client';

import { VISUALIZATION_EXPORT_MESSAGE } from '@/lib/video-export-app/export-options';
import { useCallback, useRef, useState } from 'react';
import { saveAs } from 'file-saver';
import { toast } from 'sonner';
import { slideToPng } from '@openmaic/renderer/snapshot';
import type { Slide } from '@openmaic/dsl';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store';
import { isMediaPlaceholder } from '@/lib/store/media-generation';
import type { Scene } from '@/lib/types/stage';
import type { SpeechAction } from '@/lib/types/action';
import { db, type MediaFileRecord } from '@/lib/utils/database';
import { buildStageAssetManifest } from '@/lib/media/asset-manifest';
import { buildVideoFrameExportPlan, sanitizeVideoFrameFilenamePart } from './video-frame-planner';
import { type VideoFrameEntry } from './video-frame-types';
import { collectAudioFiles, collectMediaFiles } from './classroom-zip-utils';
import { inlineHtmlAssets, createAssetFetcher } from './inline-assets';
import { createProxiedFetch } from './proxied-fetch';
import { generateStandaloneQuizHtml } from './quiz-html';
import { withVideoFrameSidecarMetadata } from './video-frame-manifest';
import type { LocalMp4VisualEffects } from './mp4/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('ExportVideoFrames');

export const VIDEO_FRAME_WIDTH = 1280;
export const VIDEO_FRAME_HEIGHT = 720;

type ExportT = (key: string, options?: Record<string, unknown>) => string;

type SnapshotEffects = {
  spotlight?: {
    elementId: string;
    dimOpacity?: number;
    static?: boolean;
  };
  laser?: {
    elementId: string;
    color?: string;
    static?: boolean;
  };
};

type SnapshotMediaElement = {
  type: string;
  src?: string;
  mediaRef?: string;
  poster?: string;
};

export function useExportVideoFrames() {
  const [exporting, setExporting] = useState(false);
  const exportingRef = useRef(false);
  const { t } = useI18n();

  const exportVideoFrames = useCallback(async () => {
    if (exportingRef.current) return;

    const { stage, scenes } = useStageStore.getState();
    if (!stage || scenes.length === 0) {
      toast.error(t('export.videoFrames.noScenes'));
      return;
    }

    if (scenes.some((scene) => scene.type === 'visualization')) {
      toast.error(VISUALIZATION_EXPORT_MESSAGE);
      return;
    }
    exportingRef.current = true;
    setExporting(true);
    const toastId = toast.loading(t('export.videoFrames.exporting'));

    try {
      const JSZip = (await import('jszip')).default;
      const latestStage = await db.stages.get(stage.id).catch(() => undefined);
      const stageTitle = latestStage?.name || stage.name || 'classroom';
      const plan = buildVideoFrameExportPlan({ stageTitle, scenes });
      const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
      const mediaRecords = await db.mediaFiles.where('stageId').equals(stage.id).toArray();
      const assetManifest = await buildStageAssetManifest(stage, scenes, stage.id);
      const audioEntries = assetManifest.entries.filter((entry) => entry.kind === 'audio');
      const mediaEntries = assetManifest.entries.filter((entry) => entry.kind !== 'audio');
      const audioRecords = await collectAudioFiles(audioEntries);
      const generatedMedia = await collectMediaFiles(stage.id, mediaEntries);
      const audioById = new Map(audioRecords.map((audio) => [audio.record.id, audio.record]));
      const manifest = withVideoFrameSidecarMetadata(
        plan.manifest,
        scenes,
        audioById,
        generatedMedia,
      );
      const htmlAssetFetcher = createAssetFetcher({ fetchImpl: createProxiedFetch() });
      const failedHtmlAssetUrls = new Set<string>();
      const zip = new JSZip();

      for (const frame of plan.frames) {
        const scene = sceneById.get(frame.sceneId);
        const blob = await renderVideoFrame(frame, scene, mediaRecords, t);
        zip.file(frame.file, blob);
        if (scene) zip.file(frame.sceneFile, JSON.stringify(scene, null, 2));
        if (
          scene?.content.type === 'interactive' &&
          scene.content.html &&
          frame.html.supported &&
          frame.html.kind === 'interactive' &&
          frame.html.file
        ) {
          const { html, report } = await inlineHtmlAssets(scene.content.html, {
            fetcher: htmlAssetFetcher,
          });
          for (const failure of report.failed) failedHtmlAssetUrls.add(failure.url);
          zip.file(frame.html.file, html);
        }
        if (
          scene?.content.type === 'quiz' &&
          frame.html.supported &&
          frame.html.kind === 'quiz' &&
          frame.html.file
        ) {
          const result = generateStandaloneQuizHtml({
            sceneTitle: scene.title,
            content: scene.content,
          });
          if (result.supported) zip.file(frame.html.file, result.html);
        }
      }

      for (const frame of manifest.frames) {
        for (const audio of frame.audio) {
          if (!audio.file) continue;
          const scene = sceneById.get(frame.sceneId);
          const action = scene?.actions?.[audio.actionIndex];
          const audioId = action?.type === 'speech' ? (action as SpeechAction).audioId : undefined;
          const record = audioId ? audioById.get(audioId) : undefined;
          if (record) zip.file(audio.file, record.blob);
        }
      }

      for (const media of generatedMedia) {
        zip.file(media.zipPath, media.record.blob);
        if (media.record.poster) {
          zip.file(media.zipPath.replace(/\.\w+$/, '.poster.jpg'), media.record.poster);
        }
      }

      zip.file('manifest.json', JSON.stringify(manifest, null, 2));

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      saveAs(zipBlob, `${sanitizeVideoFrameFilenamePart(stageTitle)}-video-artifact.zip`);
      toast.success(t('export.videoFrames.exportSuccess'), { id: toastId });
      if (failedHtmlAssetUrls.size > 0) {
        toast.warning(t('export.inlinePartial', { count: failedHtmlAssetUrls.size }), {
          description: formatHosts([...failedHtmlAssetUrls]),
        });
      }
    } catch (error) {
      log.error('Video frame export failed:', error);
      toast.error(t('export.videoFrames.exportFailed'), { id: toastId });
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  }, [t]);

  return { exporting, exportVideoFrames };
}

function formatHosts(urls: string[]): string {
  return [
    ...new Set(
      urls.map((url) => {
        try {
          return new URL(url).host;
        } catch {
          return url;
        }
      }),
    ),
  ].join(', ');
}

export async function renderVideoFrame(
  frame: VideoFrameEntry,
  scene: Scene | undefined,
  mediaRecords: MediaFileRecord[],
  t: ExportT,
  effects?: LocalMp4VisualEffects,
): Promise<Blob> {
  return scene && frame.renderMode === 'slide-snapshot' && scene.content.type === 'slide'
    ? renderSlideFrame(scene, mediaRecords, effects)
    : renderPlaceholderFrame(frame, t);
}

export async function renderSlideFrame(
  scene: Scene,
  mediaRecords: MediaFileRecord[],
  effects?: LocalMp4VisualEffects,
): Promise<Blob> {
  if (scene.content.type !== 'slide') {
    throw new Error(`Scene ${scene.id} is not a slide scene`);
  }

  const { slide, revoke } = resolveGeneratedMediaForSnapshot(scene.content.canvas, mediaRecords);
  try {
    const snapshotOptions = {
      width: VIDEO_FRAME_WIDTH,
      pixelRatio: 1,
      backgroundColor: '#ffffff',
      format: 'blob' as const,
      effects: toSlideEffects(effects),
    };
    const output = await slideToPng(slide, snapshotOptions);
    if (output instanceof Blob) return output;
    return await fetch(output).then((res) => res.blob());
  } finally {
    revoke();
  }
}

function toSlideEffects(effects?: LocalMp4VisualEffects): SnapshotEffects | undefined {
  if (!effects?.spotlight && !effects?.laser) return undefined;
  return {
    spotlight: effects.spotlight
      ? {
          elementId: effects.spotlight.elementId,
          dimOpacity: effects.spotlight.dimOpacity,
          static: true,
        }
      : undefined,
    laser: effects.laser
      ? {
          elementId: effects.laser.elementId,
          color: effects.laser.color,
          static: true,
        }
      : undefined,
  };
}

function resolveGeneratedMediaForSnapshot(
  sourceSlide: Slide,
  mediaRecords: MediaFileRecord[],
): { slide: Slide; revoke: () => void } {
  const slide = structuredClone(sourceSlide);
  const objectUrls: string[] = [];
  const videoRecords = mediaRecords.filter((record) => !record.error && record.type === 'video');
  const mediaByElementId = new Map(
    mediaRecords.map((record) => [getMediaRecordElementId(record.id), record] as const),
  );

  for (const element of slide.elements as SnapshotMediaElement[]) {
    const mediaRef = getSnapshotMediaRef(element);
    if (!mediaRef) continue;

    const exactRecord = mediaByElementId.get(mediaRef);
    const fallbackRecord =
      !exactRecord && element.type === 'video' && isLegacySequentialVideoRef(mediaRef)
        ? videoRecords.length === 1
          ? videoRecords[0]
          : undefined
        : undefined;
    const record = exactRecord && !exactRecord.error ? exactRecord : fallbackRecord;

    if (!record) {
      if (element.type === 'image') element.src = '';
      continue;
    }

    if (element.type === 'image' && record.type === 'image') {
      const url = URL.createObjectURL(blobWithType(record.blob, record.mimeType));
      objectUrls.push(url);
      element.src = url;
    } else if (element.type === 'video' && record.type === 'video') {
      const url = URL.createObjectURL(blobWithType(record.blob, record.mimeType));
      objectUrls.push(url);
      element.src = url;
      if (record.poster) {
        const poster = URL.createObjectURL(blobWithType(record.poster, 'image/jpeg'));
        objectUrls.push(poster);
        element.poster = poster;
      }
    } else if (element.type === 'image') {
      element.src = '';
    }
  }

  return {
    slide,
    revoke: () => objectUrls.forEach((url) => URL.revokeObjectURL(url)),
  };
}

function getSnapshotMediaRef(element: SnapshotMediaElement): string | undefined {
  if (element.type === 'image' && element.src && isMediaPlaceholder(element.src)) {
    return element.src;
  }
  if (element.type === 'video') {
    if (element.mediaRef && isMediaPlaceholder(element.mediaRef)) return element.mediaRef;
    if (element.src && isMediaPlaceholder(element.src)) return element.src;
  }
  return undefined;
}

function isLegacySequentialVideoRef(value: string): boolean {
  return /^gen_vid_\d+$/i.test(value);
}

function getMediaRecordElementId(recordId: string): string {
  return recordId.includes(':') ? recordId.split(':').slice(1).join(':') : recordId;
}

function blobWithType(blob: Blob, mimeType: string): Blob {
  return blob.type ? blob : new Blob([blob], { type: mimeType });
}

export async function renderPlaceholderFrame(frame: VideoFrameEntry, t: ExportT): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = VIDEO_FRAME_WIDTH;
  canvas.height = VIDEO_FRAME_HEIGHT;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context is unavailable');

  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, VIDEO_FRAME_WIDTH, VIDEO_FRAME_HEIGHT);

  ctx.fillStyle = '#e2e8f0';
  ctx.fillRect(72, 72, VIDEO_FRAME_WIDTH - 144, VIDEO_FRAME_HEIGHT - 144);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(76, 76, VIDEO_FRAME_WIDTH - 152, VIDEO_FRAME_HEIGHT - 152);

  ctx.fillStyle = '#64748b';
  ctx.font = '600 24px Inter, system-ui, sans-serif';
  ctx.fillText(t('export.videoFrames.placeholderBrand'), 116, 140);

  ctx.fillStyle = '#0f172a';
  ctx.font = '700 44px Inter, system-ui, sans-serif';
  drawWrappedText(
    ctx,
    t('export.videoFrames.placeholderHeading', { sceneType: frame.sceneType }),
    116,
    228,
    VIDEO_FRAME_WIDTH - 232,
    56,
    2,
  );

  ctx.fillStyle = '#334155';
  ctx.font = '500 30px Inter, system-ui, sans-serif';
  drawWrappedText(ctx, frame.sceneTitle, 116, 330, VIDEO_FRAME_WIDTH - 232, 42, 2);

  ctx.fillStyle = '#64748b';
  ctx.font = '400 24px Inter, system-ui, sans-serif';
  drawWrappedText(
    ctx,
    frame.html.supported && frame.html.file
      ? t('export.videoFrames.placeholderHtmlMessage')
      : t('export.videoFrames.placeholderMessage'),
    116,
    430,
    VIDEO_FRAME_WIDTH - 232,
    34,
    2,
  );
  drawWrappedText(
    ctx,
    frame.html.supported && frame.html.file
      ? t('export.videoFrames.placeholderHtmlHint', { file: frame.html.file })
      : t('export.videoFrames.placeholderHint'),
    116,
    500,
    VIDEO_FRAME_WIDTH - 232,
    34,
    2,
  );

  ctx.fillStyle = '#94a3b8';
  ctx.font = '600 20px Inter, system-ui, sans-serif';
  ctx.fillText(t('export.videoFrames.placeholderScene', { index: frame.index }), 116, 620);

  return canvasToBlob(canvas);
}

function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
) {
  const lines = wrapCanvasLines(ctx, text, maxWidth, maxLines);
  lines.forEach((line, index) => {
    ctx.fillText(line, x, y + index * lineHeight);
  });
}

function wrapCanvasLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const tokens = text.match(/\S+\s*/g) ?? [];
  const lines: string[] = [];
  let line = '';

  for (const token of tokens) {
    const candidate = `${line}${token}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }

    if (line.trim()) {
      lines.push(line.trimEnd());
      if (lines.length === maxLines) return ellipsizeLastLine(ctx, lines, maxWidth);
      line = '';
    }

    for (const char of token) {
      const charCandidate = `${line}${char}`;
      if (ctx.measureText(charCandidate).width <= maxWidth) {
        line = charCandidate;
      } else {
        if (line.trim()) {
          lines.push(line.trimEnd());
          if (lines.length === maxLines) return ellipsizeLastLine(ctx, lines, maxWidth);
        }
        line = char;
      }
    }
  }

  if (line.trim()) lines.push(line.trimEnd());
  return ellipsizeLastLine(ctx, lines.slice(0, maxLines), maxWidth);
}

function ellipsizeLastLine(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  maxWidth: number,
): string[] {
  if (lines.length === 0) return lines;
  const lastIndex = lines.length - 1;
  let last = lines[lastIndex];
  if (ctx.measureText(last).width <= maxWidth) return lines;

  while (last.length > 0 && ctx.measureText(`${last}...`).width > maxWidth) {
    last = last.slice(0, -1);
  }
  lines[lastIndex] = `${last.trimEnd()}...`;
  return lines;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Video frame placeholder canvas produced no blob'));
    }, 'image/png');
  });
}
