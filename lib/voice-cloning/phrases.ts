export type VoiceEnrollmentLanguage = 'en' | 'hi' | 'mr';

export interface VoiceEnrollmentPhrase {
  id: string;
  text: string;
  consent?: boolean;
}

export const VOICE_CLONING_CONSENT_VERSION = 'faculty-self-voice-v1';

export const VOICE_ENROLLMENT_PARAGRAPH =
  'Today we will take a simple idea, look at it from two sides, and connect it to an example you can remember. Speak naturally, pause where it feels right, and keep the explanation clear for the class.';

export const VOICE_ENROLLMENT_PHRASES: Record<VoiceEnrollmentLanguage, VoiceEnrollmentPhrase[]> = {
  en: [
    {
      id: 'teaching-paragraph',
      text: VOICE_ENROLLMENT_PARAGRAPH,
    },
  ],
  hi: [{
    id: 'teaching-paragraph-hi-v1',
    text: 'आज हम एक सरल विचार को समझेंगे और उसे एक ऐसे उदाहरण से जोड़ेंगे जो आपको याद रहे। ध्यान से सुनिए, अपने सवाल पूछिए और हर नए विषय को सीखने के लिए थोड़ा समय दीजिए।',
  }],
  mr: [{
    id: 'teaching-paragraph-mr-v1',
    text: 'आज आपण एक सोपी कल्पना समजून घेऊ आणि ती लक्षात राहील अशा उदाहरणाशी जोडू. लक्ष देऊन ऐका, मनातले प्रश्न विचारा आणि प्रत्येक नवीन विषय शिकण्यासाठी थोडा वेळ द्या.',
  }],
};

export const VOICE_PREVIEW_TEXT =
  'Welcome to the course. Today we are going to explore this topic together.';

export function getVoiceEnrollmentPhrases(language: string | undefined): VoiceEnrollmentPhrase[] {
  if (language !== 'en' && language !== 'hi' && language !== 'mr') return [];
  return VOICE_ENROLLMENT_PHRASES[language];
}

export function getVoicePreviewText(language: string, provider: string): string {
  if (language === 'hi') return 'पाठ में आपका स्वागत है। आज हम इस विषय को सरल उदाहरणों के साथ समझेंगे।';
  if (language === 'mr') return 'या धड्यात तुमचे स्वागत आहे. आज आपण हा विषय सोप्या उदाहरणांसह शिकणार आहोत.';
  if (language === 'en' || provider === 'chatterbox') return VOICE_PREVIEW_TEXT;
  throw new Error('Unsupported Teaching Voice preview language');
}
