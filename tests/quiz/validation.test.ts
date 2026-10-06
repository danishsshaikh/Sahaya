import { describe, expect, it, vi } from 'vitest';
import { normalizeQuizQuestions } from '@/lib/quiz/validation';

describe('quiz payload validation', () => {
  it('keeps valid questions while dropping malformed questions and option text', () => {
    const report = vi.fn();
    const questions = normalizeQuizQuestions(
      [
        {
          id: 'q1',
          type: 'single',
          question: 'Which formula is correct?',
          options: [{ value: 'A', label: '$x^2$' }, { value: 'B' }, { value: 'C', label: '$x^3$' }],
          answer: ['A'],
        },
        { id: 'broken', type: 'single', options: [{ value: 'A', label: 'Missing prompt' }] },
        {
          id: 'q2',
          type: 'short_answer',
          question: 'Explain the result.',
          analysis: undefined,
          commentPrompt: undefined,
        },
      ],
      'scene-quiz',
      report,
    );

    expect(questions).toEqual([
      expect.objectContaining({
        id: 'q1',
        question: 'Which formula is correct?',
        options: [
          { value: 'A', label: '$x^2$' },
          { value: 'C', label: '$x^3$' },
        ],
        answer: ['A'],
      }),
      expect.objectContaining({ id: 'q2', type: 'short_answer' }),
    ]);
    expect(questions[1]).not.toHaveProperty('analysis');
    expect(questions[1]).not.toHaveProperty('commentPrompt');
    expect(questions[1]).not.toHaveProperty('answer');
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        sceneId: 'scene-quiz',
        questionIndex: 0,
        field: 'options[1].label',
        reason: 'missing-option-text',
      }),
    );
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ questionIndex: 1, field: 'question' }),
    );
  });

  it('normalizes plain-string options and leaves optional answer metadata absent', () => {
    expect(
      normalizeQuizQuestions(
        [
          {
            id: 'q1',
            type: 'multiple',
            question: 'Select the variables.',
            options: ['x', 'y'],
          },
        ],
        'scene-quiz',
        vi.fn(),
      ),
    ).toEqual([
      {
        id: 'q1',
        type: 'multiple',
        question: 'Select the variables.',
        options: [
          { value: 'A', label: 'x' },
          { value: 'B', label: 'y' },
        ],
      },
    ]);
  });
});
