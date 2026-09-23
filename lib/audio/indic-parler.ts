import type { TTSVoiceInfo } from './types';

// App-side description choices copied verbatim from services/indic-parler-tts/README.md.
// These are not service speaker IDs or registered voices; only the description is sent.
export const INDIC_PARLER_VOICES: TTSVoiceInfo[] = [
  {
    id: 'default',
    name: 'Indic Parler Default (English description)',
    language: 'en',
    description:
      'An Indian English teacher speaks clearly at a moderate pace with a calm and engaging delivery. The recording is clean and close.',
  },
  {
    id: 'hindi-description',
    name: 'Hindi description',
    language: 'hi',
    description:
      'A Hindi teacher speaks clearly at a moderate pace with a calm classroom delivery. The recording is clean and close.',
  },
  {
    id: 'marathi-description',
    name: 'Marathi description',
    language: 'mr',
    description:
      'A Marathi teacher speaks clearly at a moderate pace with an engaging classroom delivery. The recording is clean and close.',
  },
];

export const INDIC_PARLER_MAX_TEXT_CHARS = 4000;
