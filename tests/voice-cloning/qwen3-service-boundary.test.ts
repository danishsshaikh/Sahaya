import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const servicePath = join(process.cwd(), 'services/qwen3-voice-cloning/service.py');

describe('Qwen3 Teaching Voice service boundary', () => {
  it('keeps target narration text separate from reference transcript metadata', () => {
    const source = readFileSync(servicePath, 'utf8');

    expect(source).toContain('text=text,');
    expect(source).toContain('ref_text=profile.reference_text,');
    expect(source).not.toContain('profile.reference_text + text');
    expect(source).not.toContain('profile.reference_text + " " + text');
    expect(source).not.toContain('f"{profile.reference_text} {text}"');
  });

  it('keeps the acoustic reference boundary while preventing full-ICL content continuation', () => {
    const source = readFileSync(servicePath, 'utf8');

    expect(source).toContain('REFERENCE_TAIL_SILENCE_SECONDS = 0.35');
    expect(source).toContain('def prepare_reference_audio_for_icl');
    expect(source).toContain('tail = active.numpy.zeros');
    expect(source).toContain('bounded = active.numpy.concatenate([audio, tail], axis=0)');
    expect(source).toContain('reference_audio = prepare_reference_audio_for_icl');
    expect(source).toContain('ref_audio=str(reference_audio),');
    expect(source).toContain('x_vector_only_mode=True,');
    expect(source).toContain('conditioningMode=speaker-embedding');
    expect(source).not.toMatch(/x_vector_only_mode\s*=\s*False/);
  });

  it('serializes only the generated waveform without reference-audio concatenation or trimming', () => {
    const source = readFileSync(servicePath, 'utf8');

    expect(source).toContain('return wavs[0], int(sample_rate)');
    expect(source).toContain('payload, output_seconds = serialize_wav(active, audio, sample_rate)');
    expect(source).not.toMatch(
      /concatenate\(\[\s*(?:reference|profile\.reference_audio)[^\]]*,\s*audio/,
    );
    expect(source).not.toMatch(/audio\s*=\s*audio\[\s*int\(/);
  });
});
