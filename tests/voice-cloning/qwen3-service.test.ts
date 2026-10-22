import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(process.cwd(), 'services/qwen3-tts/service.py'), 'utf8');

describe('Qwen3-TTS preview service scaffold', () => {
  it('loads the cached 1.7B Base model once on logical CUDA device zero', () => {
    expect(source).toContain('Qwen/Qwen3-TTS-12Hz-1.7B-Base');
    expect(source).toContain('@app.on_event("startup")');
    expect(source).toContain('Qwen3TTSModel.from_pretrained(');
    expect(source).toContain('device_map="cuda:0"');
    expect(source).toContain('local_files_only=True');
  });

  it('caches isolated ICL and speaker-only prompts from the unchanged reference WAV', () => {
    expect(source).toContain('active_model.create_voice_clone_prompt(');
    expect(source).toContain('ref_audio=str(reference)');
    expect(source).toContain('ref_text=None if x_vector_only else req.referenceText');
    expect(source).toContain('x_vector_only_mode=x_vector_only');
    expect(source).toContain('req.cloneMode: prompt');
  });

  it('serializes generated Qwen audio as PCM16 WAV without provider fallback', () => {
    expect(source).toContain('active_model.generate_voice_clone(');
    expect(source).toContain('prompt = profile.prompts.get(req.cloneMode)');
    expect(source).toContain('voice_clone_prompt=prompt');
    expect(source).toContain('subtype="PCM_16"');
    expect(source).not.toContain('chatterbox');
    expect(source).not.toContain('indicf5');
  });
});
