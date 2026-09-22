import { TeachingVoiceHttpProvider } from './teaching-voice-http';

export class Qwen3VoiceCloningProvider extends TeachingVoiceHttpProvider {
  constructor() {
    super('qwen3');
  }

  protected prepareText(text: string): string {
    return text;
  }
}
