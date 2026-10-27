import type {
  VoiceComparisonLanguageCode,
  VoiceComparisonProviderId,
} from '@/lib/voice-comparison/types';

export type CourseNarrationVersionStatus = 'generating' | 'complete' | 'failed' | 'cancelled';

export interface CourseNarrationClip {
  /** Exact text that was sent for this speech action. */
  transcript: string;
  transcriptFingerprint: string;
  audioId?: string;
  durationSeconds?: number;
  outputCodec?: string;
  chunked?: boolean;
}

export interface CourseNarrationSceneVersion {
  sceneId: string;
  clips: Record<string, CourseNarrationClip>;
  durationSeconds?: number;
}

export interface CourseNarrationFailure {
  sceneId: string;
  actionId?: string;
  message: string;
}

export interface CourseNarrationVersion {
  id: string;
  providerId: VoiceComparisonProviderId | 'original';
  providerName: string;
  profileId?: string;
  voiceLabel?: string;
  language: VoiceComparisonLanguageCode;
  settings: {
    voice?: string;
    style?: string;
    enhancementMode?: 'standard' | 'resemble-enhance';
    processingMode?: string;
  };
  createdAt: string;
  updatedAt: string;
  status: CourseNarrationVersionStatus;
  contentFingerprint: string;
  scenes: Record<string, CourseNarrationSceneVersion>;
  failures: CourseNarrationFailure[];
  totalDurationSeconds?: number;
  experimental?: boolean;
}

export interface CourseNarrationState {
  schemaVersion: 1;
  activeVersionId: string;
  versions: CourseNarrationVersion[];
}

export interface CourseNarrationSelection {
  providerId: VoiceComparisonProviderId;
  providerName: string;
  profileId?: string;
  language: VoiceComparisonLanguageCode;
  voice?: string;
  style?: string;
  enhancementMode?: 'standard' | 'resemble-enhance';
  experimental?: boolean;
}
