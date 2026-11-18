import type {
  VoiceComparisonLanguage,
  VoiceComparisonLanguageCode,
  VoiceComparisonPresetVoice,
  VoiceComparisonProviderCapability,
  VoiceComparisonProviderId,
} from '@/lib/voice-comparison/types';

export const VOICE_COMPARISON_LANGUAGES: VoiceComparisonLanguage[] = [
  { code: 'as', label: 'Assamese' },
  { code: 'bn', label: 'Bengali' },
  { code: 'brx', label: 'Bodo' },
  { code: 'doi', label: 'Dogri' },
  { code: 'en', label: 'English' },
  { code: 'gu', label: 'Gujarati' },
  { code: 'hi', label: 'Hindi' },
  { code: 'kn', label: 'Kannada' },
  { code: 'kok', label: 'Konkani' },
  { code: 'ks', label: 'Kashmiri' },
  { code: 'mai', label: 'Maithili' },
  { code: 'ml', label: 'Malayalam' },
  { code: 'mni', label: 'Manipuri' },
  { code: 'mr', label: 'Marathi' },
  { code: 'ne', label: 'Nepali' },
  { code: 'or', label: 'Odia' },
  { code: 'pa', label: 'Punjabi' },
  { code: 'sa', label: 'Sanskrit' },
  { code: 'sat', label: 'Santali' },
  { code: 'sd', label: 'Sindhi' },
  { code: 'ta', label: 'Tamil' },
  { code: 'te', label: 'Telugu' },
  { code: 'ur', label: 'Urdu' },
];

export const SARVAM_LANGUAGE_CODES: Partial<Record<VoiceComparisonLanguageCode, string>> = {
  as: 'as-IN',
  bn: 'bn-IN',
  en: 'en-IN',
  gu: 'gu-IN',
  hi: 'hi-IN',
  kn: 'kn-IN',
  ml: 'ml-IN',
  mr: 'mr-IN',
  or: 'od-IN',
  pa: 'pa-IN',
  ta: 'ta-IN',
  te: 'te-IN',
};

const BODHAN_RECORDED_VOICES: Array<[VoiceComparisonLanguageCode, string, string, string?]> = [
  ['as', 'Prastuti', 'Ankur'],
  ['bn', 'Ishita', 'Sourav'],
  ['brx', 'Gwrbw', 'Sansuma'],
  ['doi', 'Preeti', 'Sham'],
  ['gu', 'Dhara', 'Parth'],
  ['hi', 'Kavya', 'Amit', 'Suhani'],
  ['kn', 'Deepika', 'Adarsh'],
  ['kok', 'Anjali', 'Sandeep'],
  ['ks', 'Zoon', 'Ishfaq'],
  ['mai', 'Vaidehi', 'Madhukar'],
  ['ml', 'Lakshmi', 'Kiran'],
  ['mni', 'Thoibi', 'Chaoba'],
  ['mr', 'Anagha', 'Chinmay'],
  ['ne', 'Srijana', 'Sagar'],
  ['or', 'Itishree', 'Akash'],
  ['pa', 'Kaur', 'Manpreet'],
  ['sa', 'Bharati', 'Aryaman'],
  ['sat', 'Phulmani', 'Sibu'],
  ['sd', 'Moomal', 'Rano'],
  ['ta', 'Anitha', 'Arun'],
  ['te', 'Sravani', 'Vamsi'],
  ['ur', 'Saba', 'Zaid'],
];

const LANGUAGE_LABELS = Object.fromEntries(
  VOICE_COMPARISON_LANGUAGES.map(({ code, label }) => [code, label]),
) as Record<VoiceComparisonLanguageCode, string>;

export const BODHAN_VOICES: VoiceComparisonPresetVoice[] = BODHAN_RECORDED_VOICES.flatMap(
  ([recordedLanguage, female, male, secondFemale]) =>
    [female, secondFemale, male]
      .filter((name): name is string => Boolean(name))
      .map((name) => ({
        id: name,
        name,
        recordedLanguage,
        recordedLanguageLabel: LANGUAGE_LABELS[recordedLanguage],
      })),
);

export const BODHAN_STYLES = [
  'educational lecture',
  'single person narration audiobook',
  "children's stories",
  'AIR style news',
  'Customer Care',
  'TV style news',
  'advertisements',
  'anger',
  'disgust',
  'fear',
  'happy',
  'news',
  'sad',
  'surprise',
] as const;

const ALL_BODHAN_LANGUAGES = VOICE_COMPARISON_LANGUAGES.map(({ code }) => code);
const ALL_SARVAM_LANGUAGES = Object.keys(SARVAM_LANGUAGE_CODES) as VoiceComparisonLanguageCode[];

export const VOICE_COMPARISON_PROVIDERS: VoiceComparisonProviderCapability[] = [
  {
    id: 'chatterbox',
    name: 'Chatterbox V3',
    category: 'voice-cloning',
    voiceType: 'cloned',
    supportedLanguages: ['en', 'hi'],
    supportsCloning: true,
    supportsPresetVoices: false,
    supportsEnhancement: true,
    supportsClassroom: true,
    supportsPreview: true,
    experimental: false,
    supportsCourseNarration: true,
  },
  {
    id: 'qwen3-tts',
    name: 'Qwen3-TTS 1.7B',
    category: 'voice-cloning',
    voiceType: 'cloned',
    supportedLanguages: ['en'],
    supportsCloning: true,
    supportsPresetVoices: false,
    supportsEnhancement: true,
    supportsClassroom: true,
    supportsPreview: true,
    experimental: false,
    supportsCourseNarration: true,
  },
  {
    id: 'sarvam',
    name: 'Sarvam AI',
    category: 'voice-cloning',
    voiceType: 'cloned',
    supportedLanguages: ALL_SARVAM_LANGUAGES,
    supportsCloning: true,
    supportsPresetVoices: false,
    supportsEnhancement: false,
    supportsClassroom: false,
    supportsPreview: true,
    experimental: true,
    supportsCourseNarration: true,
  },
  {
    id: 'bodhan',
    name: 'Bodhan Indic-Speak',
    category: 'preset-voices',
    voiceType: 'preset',
    supportedLanguages: ALL_BODHAN_LANGUAGES,
    supportsCloning: false,
    supportsPresetVoices: true,
    supportsEnhancement: false,
    supportsClassroom: false,
    supportsPreview: true,
    experimental: true,
    supportsCourseNarration: true,
  },
  {
    id: 'ming3-tts',
    name: 'Ming 3.0 TTS 0.5B',
    category: 'voice-cloning',
    voiceType: 'cloned',
    supportedLanguages: ['en'],
    supportsCloning: true,
    supportsPresetVoices: false,
    supportsEnhancement: false,
    supportsClassroom: false,
    supportsPreview: true,
    experimental: true,
    supportsCourseNarration: true,
  },
  {
    id: 'indicf5',
    name: 'IndicF5',
    category: 'voice-cloning',
    voiceType: 'cloned',
    supportedLanguages: ['hi', 'mr'],
    supportsCloning: true,
    supportsPresetVoices: false,
    supportsEnhancement: false,
    supportsClassroom: true,
    supportsPreview: true,
    experimental: false,
    supportsCourseNarration: true,
  },
];

export function getVoiceComparisonProvider(
  providerId: VoiceComparisonProviderId,
): VoiceComparisonProviderCapability {
  const provider = VOICE_COMPARISON_PROVIDERS.find(({ id }) => id === providerId);
  if (!provider) throw new Error(`Unsupported voice comparison provider: ${providerId}`);
  return provider;
}

export function isVoiceComparisonProviderId(value: unknown): value is VoiceComparisonProviderId {
  return VOICE_COMPARISON_PROVIDERS.some(({ id }) => id === value);
}

export function isVoiceComparisonLanguageCode(
  value: unknown,
): value is VoiceComparisonLanguageCode {
  return VOICE_COMPARISON_LANGUAGES.some(({ code }) => code === value);
}

export function isBodhanVoice(value: unknown): value is string {
  return typeof value === 'string' && BODHAN_VOICES.some(({ id }) => id === value);
}

export function isBodhanStyle(value: unknown): value is string {
  return typeof value === 'string' && BODHAN_STYLES.some((style) => style === value);
}
