import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(process.cwd(), 'services/qwen3-tts/service.py'), 'utf8');

describe('Qwen3-TTS Teaching Voice service scaffold', () => {
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
    expect(source).toContain('max_new_tokens=MAX_NEW_TOKENS');
    expect(source).toContain('stopping_criteria=StoppingCriteriaList([stop_signal])');
    expect(source).toContain('stop_signal.reason == "output-token-limit"');
    expect(source).toContain('subtype="PCM_16"');
    expect(source).not.toContain('chatterbox');
    expect(source).not.toContain('indicf5');
  });

  it('keeps the slot until bounded inference actually stops and logs safe timing metadata', () => {
    expect(source).toContain('class GenerationStopSignal(StoppingCriteria):');
    expect(source).toContain('async def wait_for_inference(');
    expect(source).toContain('return await task');
    expect(source).toContain('finally:\n        generation_queue.release()');
    expect(source).toContain('Qwen3-TTS inference started');
    expect(source).toContain('Qwen3-TTS inference completed');
    expect(source).toContain('audioDurationSeconds=%.3f');
    expect(source).not.toContain('text=%s');
  });

  it('queues profile creation and synthesis fairly instead of returning immediate busy', () => {
    expect(source).toContain('class FairGenerationQueue:');
    expect(source).toContain('self._waiters.append(token)');
    expect(source).toContain('self._waiters[0] is not token');
    expect(source).toContain('acquire_generation_slot("profile-registration")');
    expect(source).toContain('asyncio.to_thread(acquire_generation_slot, "synthesis")');
    expect(source).toContain('QWEN3_TTS_QUEUE_WAIT_SECONDS');
    expect(source).not.toContain('generation_lock.acquire(blocking=False)');
  });

  it('keeps prompts transient and supports explicit cache removal', () => {
    expect(source).toContain('profiles: dict[str, VoicePrompt] = {}');
    expect(source).toContain('@app.delete("/profiles/{profile_id}")');
    expect(source).toContain('profiles.pop(profile_id, None)');
    expect(source).toContain('detail="voice profile not found"');
  });
});
