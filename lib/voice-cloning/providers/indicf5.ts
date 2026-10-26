import { TeachingVoiceHttpProvider } from './teaching-voice-http';
import { normalizeIndicTeachingText } from '../indic-text-normalizer';

export class IndicF5VoiceCloningProvider extends TeachingVoiceHttpProvider {
  constructor() {
    super('indicf5');
  }

  protected prepareText(text: string, language: string): string {
    return normalizeIndicTeachingText(text, language);
  }
}
