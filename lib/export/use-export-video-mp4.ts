'use client';

import { VISUALIZATION_EXPORT_MESSAGE } from '@/lib/video-export-app/export-options';
import { useCallback, useRef, useState } from 'react';
import { saveAs } from 'file-saver';
import { toast } from 'sonner';
import type { LegacySpeechAction, SpeechAction } from '@/lib/types/action';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store';
import { collectAudioFiles } from './classroom-zip-utils';
import { buildStageAssetManifest } from '@/lib/media/asset-manifest';
import { compressFrameForMp4Upload } from './mp4/frame-compression';
import {
  buildLocalMp4Manifest,
  buildLocalMp4SpeechSegmentVisualPlan,
  buildLocalMp4VisualFrameFile,
  sanitizeMp4PathPart,
  speechAudioLookupIds,
} from './mp4/planner';
import {
  advanceLocalMp4ExportProgress,
  createLocalMp4ExportProgress,
  describeLocalMp4ExportProgress,
  type LocalMp4ExportPhase,
} from './mp4/progress';
import type { LocalMp4MissingAudio, LocalMp4VisualEffects } from './mp4/types';
import { buildVideoFrameExportPlan, sanitizeVideoFrameFilenamePart } from './video-frame-planner';
import { renderVideoFrame, VIDEO_FRAME_HEIGHT, VIDEO_FRAME_WIDTH } from './use-export-video-frames';
import { db, type AudioFileRecord } from '@/lib/utils/database';
import { generateAndStoreTTS } from '@/lib/hooks/use-scene-generator';
import { createLogger } from '@/lib/logger';

const log = createLogger('ExportVideoMp4');

type ActionAudioKey = `${string}:${number}`;

interface Mp4UploadDiagnostics {
  frameCount: number;
  totalFrameBytes: number;
  largestFrameBytes: number;
  audioCount: number;
  totalAudioBytes: number;
  largestAudioBytes: number;
  estimatedUploadBytes: number;
  estimatedUploadMb: string;
  frameMimeType: string;
  frameWidth?: number;
  frameHeight?: number;
}

export function useExportVideoMp4() {
  const [exporting, setExporting] = useState(false);
  const exportingRef = useRef(false);
  const { t } = useI18n();

  const exportVideoMp4 = useCallback(async () => {
    if (exportingRef.current) return;

    const { stage, scenes } = useStageStore.getState();
    if (!stage || scenes.length === 0) {
      toast.error(t('export.videoMp4.noScenes'));
      return;
    }

    if (scenes.some((scene) => scene.type === 'visualization')) {
      toast.error(VISUALIZATION_EXPORT_MESSAGE);
      return;
    }
    exportingRef.current = true;
    setExporting(true);
    const toastId = toast.loading(t('export.videoMp4.exporting'));
    const jobId = `local-mp4-${Date.now().toString(36)}`;
    let progress = createLocalMp4ExportProgress(jobId, t('export.videoMp4.exporting'));
    const renderProgress = () =>
      toast.loading(progress.message, {
        id: toastId,
        description: describeLocalMp4ExportProgress(progress),
      });
    const updateProgress = (
      phase: LocalMp4ExportPhase,
      message: string,
      units?: { completed: number; total: number },
      percent?: number,
    ) => {
      progress = advanceLocalMp4ExportProgress(progress, {
        phase,
        message,
        completedUnits: units?.completed,
        totalUnits: units?.total,
        percent,
      });
      log.info('Local MP4 progress update:', {
        jobId,
        phase: progress.phase,
        completedUnits: progress.completedUnits,
        totalUnits: progress.totalUnits,
        percent: progress.percent,
      });
      renderProgress();
    };
    const heartbeat = window.setInterval(renderProgress, 1000);

    try {
      updateProgress('preparing', t('export.videoMp4.progress.preparing'));
      const latestStage = await db.stages.get(stage.id).catch(() => undefined);
      const stageTitle = latestStage?.name || stage.name || 'classroom';
      const language = latestStage?.languageDirective || stage.languageDirective;
      const plan = buildVideoFrameExportPlan({ stageTitle, scenes });
      const mediaRecords = await db.mediaFiles.where('stageId').equals(stage.id).toArray();
      const assetManifest = await buildStageAssetManifest(stage, scenes, stage.id);
      const audioEntries = assetManifest.entries.filter((entry) => entry.kind === 'audio');
      const audioRecords = await collectAudioFiles(audioEntries);
      const audioById = new Map(audioRecords.map((audio) => [audio.record.id, audio.record]));
      const frameBlobs = new Map<string, Blob>();
      const compressedFrameBlobs = new Map<string, Blob>();
      let compressedFrameWidth = VIDEO_FRAME_WIDTH;
      let compressedFrameHeight = VIDEO_FRAME_HEIGHT;
      const audioBlobs = new Map<string, Blob>();
      const audioFilesByAction = new Map<ActionAudioKey, string>();
      const segmentVisualPlan = buildLocalMp4SpeechSegmentVisualPlan({
        frames: plan.frames,
        scenes,
        getFrameFile: ({ frame, effects }) => mp4FrameFileForFrame(frame.file, effects),
      });

      log.info('Local MP4 teaching effects prepared:', {
        jobId,
        spotlightActions: segmentVisualPlan.stats.spotlightActions,
        laserActions: segmentVisualPlan.stats.laserActions,
        assignedEffects: segmentVisualPlan.stats.assignedEffects,
        omittedEffects: segmentVisualPlan.stats.omittedEffects,
        uniqueEffectFrames: segmentVisualPlan.stats.uniqueEffectFrames,
        uniqueFrames: segmentVisualPlan.visualFrames.length,
      });
      for (const [segmentIndex, segment] of segmentVisualPlan.segments.entries()) {
        if (!segment.effects?.spotlight) continue;
        log.info('Local MP4 spotlight segment planned:', {
          jobId,
          sceneId: segment.scene.id,
          sceneIndex: segment.frame.index,
          segmentIndex: segmentIndex + 1,
          actionIndex: segment.actionIndex,
          actionId: typeof segment.action.id === 'string' ? segment.action.id : undefined,
          elementId: segment.effects.spotlight.elementId,
          dimOpacity: segment.effects.spotlight.dimOpacity,
          frameFile: segment.frameFile,
          frameKey: segment.frameKey,
        });
      }
      for (const warning of segmentVisualPlan.warnings) {
        if (warning.actionType === 'spotlight' || warning.actionType === 'laser') {
          log.warn('Local MP4 teaching effect omitted:', {
            jobId,
            sceneIndex: warning.sceneIndex,
            actionIndex: warning.actionIndex,
            actionType: warning.actionType,
            reason: warning.reason,
          });
        }
      }

      for (const [index, visualFrame] of segmentVisualPlan.visualFrames.entries()) {
        updateProgress(
          'rendering',
          t('export.videoMp4.progress.renderingFrame', {
            current: index + 1,
            total: segmentVisualPlan.visualFrames.length,
          }),
          { completed: index + 1, total: segmentVisualPlan.visualFrames.length },
        );
        log.info('Local MP4 visual frame render started:', {
          jobId,
          sceneIndex: visualFrame.frame.index,
          sceneId: visualFrame.scene.id,
          frameFile: visualFrame.file,
          effectCount:
            (visualFrame.effects?.spotlight ? 1 : 0) + (visualFrame.effects?.laser ? 1 : 0),
          hasSpotlight: !!visualFrame.effects?.spotlight,
          spotlightElementId: visualFrame.effects?.spotlight?.elementId,
          spotlightDimOpacity: visualFrame.effects?.spotlight?.dimOpacity,
          hasLaser: !!visualFrame.effects?.laser,
        });
        const blob = await renderVideoFrame(
          visualFrame.frame,
          visualFrame.scene,
          mediaRecords,
          t,
          visualFrame.effects,
        );
        frameBlobs.set(visualFrame.file, blob);
        log.info('Local MP4 visual frame render completed:', {
          jobId,
          sceneIndex: visualFrame.frame.index,
          sceneId: visualFrame.scene.id,
          frameFile: visualFrame.file,
          effectCount:
            (visualFrame.effects?.spotlight ? 1 : 0) + (visualFrame.effects?.laser ? 1 : 0),
          hasSpotlight: !!visualFrame.effects?.spotlight,
          spotlightElementId: visualFrame.effects?.spotlight?.elementId,
          hasLaser: !!visualFrame.effects?.laser,
          blobBytes: blob.size,
          blobType: blob.type,
        });
      }

      for (const [index, visualFrame] of segmentVisualPlan.visualFrames.entries()) {
        updateProgress(
          'compressing',
          t('export.videoMp4.progress.compressingFrame', {
            current: index + 1,
            total: segmentVisualPlan.visualFrames.length,
          }),
          { completed: index + 1, total: segmentVisualPlan.visualFrames.length },
        );
        const blob = frameBlobs.get(visualFrame.file);
        if (!blob)
          throw new Error(`Missing rendered MP4 frame for scene #${visualFrame.frame.index}`);
        const compressed = await compressFrameForMp4Upload(blob);
        compressedFrameBlobs.set(visualFrame.file, compressed.blob);
        compressedFrameWidth = compressed.width;
        compressedFrameHeight = compressed.height;
      }

      for (const [index, item] of segmentVisualPlan.segments.entries()) {
        updateProgress(
          'audio',
          t('export.videoMp4.progress.resolvingAudio', {
            current: index + 1,
            total: segmentVisualPlan.segments.length,
          }),
          { completed: index + 1, total: segmentVisualPlan.segments.length },
        );
        const audio = await resolveSpeechAudioBlob(
          item.scene.order,
          item.action,
          audioById,
          language,
          (current, total) =>
            updateProgress(
              'audio',
              t('export.videoMp4.progress.generatingAudio', { current, total }),
              { completed: current, total },
            ),
          index + 1,
          segmentVisualPlan.segments.length,
        );
        if (!audio) continue;

        const file = audioFileForSpeech(item.frameFile, item.speechIndex, audio.extension);
        audioFilesByAction.set(actionAudioKey(item.scene.id, item.actionIndex), file);
        audioBlobs.set(file, audio.blob);
      }

      const mp4Plan = buildLocalMp4Manifest({
        stageTitle,
        frames: plan.frames,
        scenes,
        frameWidth: compressedFrameWidth,
        frameHeight: compressedFrameHeight,
        segmentVisuals: segmentVisualPlan.segments,
        visualWarnings: segmentVisualPlan.warnings,
        resolveAudioFile: ({ scene, actionIndex }) =>
          audioFilesByAction.get(actionAudioKey(scene.id, actionIndex)) ?? null,
      });

      if (mp4Plan.missingAudio.length > 0) {
        throw new MissingAudioExportError(mp4Plan.missingAudio);
      }

      const formData = new FormData();
      formData.append('manifest', JSON.stringify(mp4Plan.manifest));

      updateProgress('uploading', t('export.videoMp4.progress.preparingUpload'));
      const usedFrameFiles = new Set(mp4Plan.manifest.segments.map((segment) => segment.frameFile));
      for (const frameFile of usedFrameFiles) {
        const blob = compressedFrameBlobs.get(frameFile);
        if (blob) formData.append(`frame:${frameFile}`, blob, fileName(frameFile));
      }

      for (const [audioFile, blob] of audioBlobs) {
        formData.append(`audio:${audioFile}`, blob, fileName(audioFile));
      }

      const diagnostics = buildUploadDiagnostics({
        frameBlobs: [...usedFrameFiles].map((frameFile) => compressedFrameBlobs.get(frameFile)),
        audioBlobs: [...audioBlobs.values()],
        manifestBytes: new Blob([JSON.stringify(mp4Plan.manifest)]).size,
        frameWidth: compressedFrameWidth,
        frameHeight: compressedFrameHeight,
      });
      log.info('Local MP4 upload diagnostics:', diagnostics);

      updateProgress('uploading', t('export.videoMp4.progress.uploading'));
      const mp4Blob = await uploadMp4Request(formData, {
        onProgress: (percent) =>
          updateProgress(
            'uploading',
            t('export.videoMp4.progress.uploadingPercent', { percent }),
            undefined,
            70 + percent * 0.15,
          ),
        onUploaded: () => updateProgress('composing', t('export.videoMp4.progress.composing')),
      });

      updateProgress('finalizing', t('export.videoMp4.progress.downloading'));
      saveAs(mp4Blob, `${sanitizeVideoFrameFilenamePart(stageTitle)}.mp4`);
      updateProgress('complete', t('export.videoMp4.exportSuccess'), undefined, 100);
      toast.success(t('export.videoMp4.exportSuccess'), { id: toastId });
    } catch (error) {
      log.error('Local MP4 export failed:', error);
      toast.error(t('export.videoMp4.exportFailed'), {
        id: toastId,
        description: getErrorMessage(error),
      });
    } finally {
      window.clearInterval(heartbeat);
      exportingRef.current = false;
      setExporting(false);
    }
  }, [t]);

  return { exporting, exportVideoMp4 };
}

async function resolveSpeechAudioBlob(
  sceneOrder: number,
  speech: SpeechAction,
  audioById: Map<string, AudioFileRecord>,
  language?: string,
  onGenerate?: (current: number, total: number) => void,
  current = 1,
  total = 1,
): Promise<{ blob: Blob; extension: string } | null> {
  const lookupIds = speechAudioLookupIds(sceneOrder, speech);
  for (const audioId of lookupIds) {
    const record = audioById.get(audioId) ?? (await db.audioFiles.get(audioId));
    if (record) {
      return {
        blob: record.blob,
        extension: normalizeAudioExtension(record.format || extensionFromMime(record.blob.type)),
      };
    }
  }

  const generatedAudioId = lookupIds[0];
  if (generatedAudioId && speech.text?.trim()) {
    onGenerate?.(current, total);
    await generateAndStoreTTS(generatedAudioId, speech.text, language);
    const record = await db.audioFiles.get(generatedAudioId);
    if (record) {
      return {
        blob: record.blob,
        extension: normalizeAudioExtension(record.format || extensionFromMime(record.blob.type)),
      };
    }
  }

  const legacyUrl = (speech as LegacySpeechAction).audioUrl;
  if (legacyUrl) {
    try {
      const response = await fetch(legacyUrl);
      if (!response.ok) return null;
      const blob = await response.blob();
      return {
        blob,
        extension: normalizeAudioExtension(
          extensionFromMime(blob.type) || extensionFromUrl(legacyUrl),
        ),
      };
    } catch {
      return null;
    }
  }

  return null;
}

function audioFileForSpeech(frameFile: string, speechIndex: number, extension: string): string {
  const frameName = fileName(frameFile)
    .replace(/\.[^.]+$/i, '')
    .replace(/-placeholder$/i, '');
  const safeBaseName = sanitizeMp4PathPart(frameName) || 'scene';
  const safeExtension = normalizeAudioExtension(extension);
  return `audio-mp4/${safeBaseName}/speech-${String(speechIndex).padStart(3, '0')}.${safeExtension}`;
}

function mp4FrameFileForFrame(frameFile: string, effects?: LocalMp4VisualEffects): string {
  const effectAwareFile = buildLocalMp4VisualFrameFile(frameFile, effects, 'jpg');
  const frameName = fileName(effectAwareFile).replace(/\.[^.]+$/i, '');
  return `frames-mp4/${sanitizeMp4PathPart(frameName) || 'scene'}.jpg`;
}

function actionAudioKey(sceneId: string, actionIndex: number): ActionAudioKey {
  return `${sceneId}:${actionIndex}`;
}

function fileName(path: string): string {
  return path.split('/').pop() || 'file';
}

function normalizeAudioExtension(extension: string | undefined): string {
  const value = (extension || 'mp3').replace(/^\./, '').toLowerCase();
  if (value === 'mpeg') return 'mp3';
  if (value === 'x-wav') return 'wav';
  return /^[a-z0-9]+$/.test(value) ? value : 'mp3';
}

function extensionFromMime(mimeType: string | undefined): string {
  if (!mimeType) return '';
  if (mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('mp4')) return 'm4a';
  return '';
}

function extensionFromUrl(url: string): string {
  try {
    const pathname = new URL(url, window.location.href).pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
    return match?.[1] || 'mp3';
  } catch {
    return 'mp3';
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Mp4UploadError && error.status === 413) {
    return (
      'MP4 export upload is too large for this server. I compressed the frames, but this ' +
      'classroom may still exceed the server limit. Try fewer scenes/audio, or increase the ' +
      'upload limit/proxy limit.'
    );
  }
  return error instanceof Error ? error.message : String(error);
}

class MissingAudioExportError extends Error {
  constructor(missingAudio: LocalMp4MissingAudio[]) {
    super(formatMissingAudio(missingAudio));
    this.name = 'MissingAudioExportError';
  }
}

function formatMissingAudio(missingAudio: LocalMp4MissingAudio[]): string {
  return missingAudio
    .slice(0, 5)
    .map((missing) => {
      const action = missing.actionId
        ? ` action ${missing.actionId}`
        : ` action #${missing.actionIndex}`;
      return `${missing.sceneTitle}${action}: ${missing.reason}`;
    })
    .join('\n');
}

function buildUploadDiagnostics({
  frameBlobs,
  audioBlobs,
  manifestBytes,
  frameWidth,
  frameHeight,
}: {
  frameBlobs: Array<Blob | undefined>;
  audioBlobs: Blob[];
  manifestBytes: number;
  frameWidth: number;
  frameHeight: number;
}): Mp4UploadDiagnostics {
  const frameSizes = frameBlobs.filter(isBlob).map((blob) => blob.size);
  const audioSizes = audioBlobs.map((blob) => blob.size);
  const totalFrameBytes = sum(frameSizes);
  const totalAudioBytes = sum(audioSizes);
  const estimatedUploadBytes = totalFrameBytes + totalAudioBytes + manifestBytes;
  return {
    frameCount: frameSizes.length,
    totalFrameBytes,
    largestFrameBytes: Math.max(0, ...frameSizes),
    audioCount: audioSizes.length,
    totalAudioBytes,
    largestAudioBytes: Math.max(0, ...audioSizes),
    estimatedUploadBytes,
    estimatedUploadMb: (estimatedUploadBytes / 1024 / 1024).toFixed(2),
    frameMimeType: 'image/jpeg',
    frameWidth,
    frameHeight,
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function isBlob(value: Blob | undefined): value is Blob {
  return value instanceof Blob;
}

function uploadMp4Request(
  formData: FormData,
  options: { onProgress?: (percent: number) => void; onUploaded?: () => void } = {},
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/export/video-mp4');
    xhr.responseType = 'blob';

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        options.onProgress?.(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.upload.onload = () => options.onUploaded?.();

    xhr.onload = async () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response);
        return;
      }

      const message = await readXhrError(xhr);
      reject(new Mp4UploadError(xhr.status, message));
    };

    xhr.onerror = () => reject(new Mp4UploadError(0, 'MP4 upload failed'));
    xhr.send(formData);
  });
}

async function readXhrError(xhr: XMLHttpRequest): Promise<string> {
  const fallback = xhr.statusText || `HTTP ${xhr.status}`;
  const response = xhr.response;
  if (!(response instanceof Blob)) return fallback;

  try {
    const text = await response.text();
    if (!text) return fallback;
    try {
      const body = JSON.parse(text);
      return body?.error?.message || text;
    } catch {
      return text;
    }
  } catch {
    return fallback;
  }
}

class Mp4UploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'Mp4UploadError';
  }
}
