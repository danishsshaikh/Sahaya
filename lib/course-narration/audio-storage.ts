'use client';

import { measureAudioDuration } from '@/lib/audio/audio-duration';
import { putAsset } from '@/lib/media/asset-pool';
import { isServerBackedMediaPersistence } from '@/lib/persistence/media-persistence';
import { db } from '@/lib/utils/database';

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function storeCourseNarrationAudio(input: {
  stageId: string;
  versionId: string;
  sceneId: string;
  actionId: string;
  text: string;
  format: string;
  base64: string;
  durationSeconds?: number;
}): Promise<{ audioId: string; durationSeconds?: number }> {
  const bytes = decodeBase64(input.base64);
  const durationSeconds =
    input.durationSeconds ?? measureAudioDuration(bytes, input.format) ?? undefined;
  const blob = new Blob([bytes.slice().buffer], { type: `audio/${input.format}` });
  const derivedId = `course_narration_${input.versionId}_${input.sceneId}_${input.actionId}`;
  const audioId = isServerBackedMediaPersistence()
    ? await putAsset(
        blob,
        {
          contentType: blob.type,
          ...(durationSeconds === undefined ? {} : { durationSeconds }),
        },
        { stageId: input.stageId },
      )
    : derivedId;

  await db.audioFiles.put({
    id: audioId,
    stageId: input.stageId,
    blob,
    duration: durationSeconds,
    format: input.format,
    text: input.text,
    createdAt: Date.now(),
  });
  return { audioId, ...(durationSeconds === undefined ? {} : { durationSeconds }) };
}
