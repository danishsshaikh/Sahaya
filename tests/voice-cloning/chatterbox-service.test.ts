import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const servicePath = join(repoRoot, 'services/voice-cloning/chatterbox_service.py');
const requirementsPath = join(repoRoot, 'services/voice-cloning/requirements.txt');

describe('Chatterbox service scaffold', () => {
  it('uses the multilingual Chatterbox module verified on HPC', () => {
    const source = readFileSync(servicePath, 'utf8');
    expect(source).toContain('from chatterbox.mtl_tts import ChatterboxMultilingualTTS');
    expect(source).not.toContain('from chatterbox.tts import ChatterboxMultilingualTTS');
  });

  it('documents the Perth/pkg_resources setuptools compatibility constraint', () => {
    const requirements = readFileSync(requirementsPath, 'utf8');
    expect(requirements).toContain('chatterbox-tts==0.1.7');
    expect(requirements).toContain('setuptools<81');
  });

  it('assembles generated chunks on CPU to avoid mixed CUDA/CPU concatenation', () => {
    const source = readFileSync(servicePath, 'utf8');
    expect(source).toContain('def completed_audio_tensor');
    expect(source).toContain('ensure_wave_tensor(wav).detach().cpu()');
    expect(source).toContain('def clean_pause_tensor');
    expect(source).toContain('torch.zeros((1, samples), dtype=dtype)');
    expect(source).toContain('assembled = torch.cat(outputs, dim=-1)');
    expect(source).toContain('return assembled');
  });

  it('cleans only multi-chunk boundaries and preserves explicit digital silence pauses', () => {
    const source = readFileSync(servicePath, 'utf8');
    expect(source).toContain('BOUNDARY_TRIM_THRESHOLD_DB');
    expect(source).toContain('def low_energy_edge_samples');
    expect(source).toContain('def clean_chunk_boundary');
    expect(source).toContain('if len(chunks) > 1:');
    expect(source).toContain('output_chunk, cleaned = clean_chunk_boundary(raw_chunk)');
    expect(source).toContain('else:\n            output_chunk = raw_chunk');
    expect(source).toContain(
      'silence = clean_pause_tensor(pause_samples, dtype=output_chunk.dtype)',
    );
    expect(source).toContain('pauseMaxAbs');
  });

  it('packs short multi-sentence text into one generation chunk where supported', () => {
    const source = readFileSync(servicePath, 'utf8');
    expect(source).toContain('MAX_TEXT_CHUNK_CHARS');
    expect(source).toContain('candidate = f"{current} {segment}".strip() if current else segment');
    expect(source).toContain('if len(candidate) <= MAX_TEXT_CHUNK_CHARS:');
    expect(source).not.toContain('if len(part) <= 420:\n                chunks.append(part)');
  });

  it('cleans temporary analyzer hooks after each generation without clearing unrelated hooks', () => {
    const source = readFileSync(servicePath, 'utf8');
    expect(source).toContain('def generation_hook_snapshot');
    expect(source).toContain('def forward_hook_count');
    expect(source).toContain('def cleanup_generation_runtime');
    expect(source).toContain('if hook_id not in existing_hook_ids:');
    expect(source).toContain('hooks.pop(hook_id, None)');
    expect(source).not.toContain('_forward_hooks.clear()');
  });

  it('restores attention config mutated by the multilingual alignment analyzer', () => {
    const source = readFileSync(servicePath, 'utf8');
    expect(source).toContain('def attention_config_snapshot');
    expect(source).toContain('"output_attentions"');
    expect(source).toContain('"_attn_implementation"');
    expect(source).toContain('def restore_attention_config');
    expect(source).toContain('configRestored');
  });

  it('wraps every model.generate call in a runtime cleanup guard', () => {
    const source = readFileSync(servicePath, 'utf8');
    expect(source).toContain('def generate_with_runtime_cleanup');
    expect(source).toContain('hooksBefore=%s');
    expect(source).toContain('hooksRemoved=%s');
    expect(source).toContain('hooksAfter=%s');
    expect(source).toContain('finally:\n        cleanup = cleanup_generation_runtime');
    expect(source).toContain('wav = generate_with_runtime_cleanup');
    expect(source).toContain('chunk=chunk');
    expect(source).not.toContain('wav = active_model.generate(\n            chunk,');
  });

  it('logs safe numeric synthesis diagnostics without logging private text or paths', () => {
    const source = readFileSync(servicePath, 'utf8');
    expect(source).toContain('voice synthesis start profileId=%s variant=%s textLen=%s chunks=%s');
    expect(source).toContain('durationMs=%s');
    expect(source).toContain('pauseMs=%s');
    expect(source).toContain('boundaryCleanupApplied=%s');
    expect(source).toContain('voice synthesis assembled profileId=%s variant=%s rawDurationMs=%s');
    expect(source).not.toContain('chunk=%s text=');
    expect(source).not.toContain('reference=%s');
  });

  it('supports explicit V2/V3 model variants with V3 as the default', () => {
    const source = readFileSync(servicePath, 'utf8');
    expect(source).toContain('DEFAULT_MODEL_VARIANT = os.getenv("CHATTERBOX_T3_MODEL", "v3")');
    expect(source).toContain('SUPPORTED_MODEL_VARIANTS = {"v2", "v3"}');
    expect(source).toContain('"v2": "t3_mtl23ls_v2.safetensors"');
    expect(source).toContain('"v3": "t3_mtl23ls_v3.safetensors"');
    expect(source).toContain('def normalize_model_variant');
    expect(source).toContain('raise ValueError(f"Unsupported modelVariant');
  });

  it('uses the runtime t3_model selector when installed and legacy V2 otherwise', () => {
    const source = readFileSync(servicePath, 'utf8');
    expect(source).toContain('def from_pretrained_supports_t3_model');
    expect(source).toContain(
      'ChatterboxMultilingualTTS.from_pretrained(device=DEVICE, t3_model=variant)',
    );
    expect(source).toContain('if variant == "v2":');
    expect(source).toContain('return ChatterboxMultilingualTTS.from_pretrained(device=DEVICE)');
  });

  it('keeps one active model variant and logs reuse/switch lifecycle', () => {
    const source = readFileSync(servicePath, 'utf8');
    expect(source).toContain('model_variant: str | None = None');
    expect(source).toContain('reusing chatterbox model variant=%s');
    expect(source).toContain('switching chatterbox model variant=%s -> %s');
    expect(source).toContain('release_active_model()');
    expect(source).toContain('torch.cuda.empty_cache()');
  });

  it('passes the selected model variant through registration and synthesis requests', () => {
    const source = readFileSync(servicePath, 'utf8');
    expect(source).toContain('modelVariant: str | None = None');
    expect(source).toContain('variant = normalize_model_variant(req.modelVariant)');
    expect(source).toContain('active_model = get_model(variant)');
  });

  it('passes the validated synthesis language to Chatterbox language_id', () => {
    const source = readFileSync(servicePath, 'utf8');
    expect(source).toContain('language = normalize_language_id(req.language)');
    expect(source).toContain('language_id=language_id');
    expect(source).toContain('SUPPORTED_LANGUAGE_IDS');
  });

  it('accepts validated per-request generation settings without changing model lifecycle', () => {
    const source = readFileSync(servicePath, 'utf8');
    expect(source).toContain('class GenerationSettings(BaseModel)');
    expect(source).toContain('generationSettings: GenerationSettings | None = None');
    expect(source).toContain(
      'generation_settings = resolve_generation_settings(req.generationSettings)',
    );
    expect(source).toContain('exaggeration=generation_settings["exaggeration"]');
    expect(source).toContain('cfg_weight=generation_settings["cfgWeight"]');
    expect(source).toContain('top_p=generation_settings["topP"]');
    expect(source).toContain('repetition_penalty=generation_settings["repetitionPenalty"]');
    expect(source).not.toContain('get_model(variant, generation_settings)');
  });
});
