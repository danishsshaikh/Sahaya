import { describe, expect, it, vi } from 'vitest';
import { generateSceneContent, type AICallFn } from '@openmaic/generation';
import type { SceneOutline } from '@/lib/types/generation';

const outline: SceneOutline = {
  id: 'quiz-outline',
  type: 'quiz',
  title: 'Safe quiz',
  description: 'Validate generated quiz data.',
  keyPoints: ['Validation'],
  order: 1,
  quizConfig: {
    questionCount: 3,
    difficulty: 'medium',
    questionTypes: ['single', 'text'],
  },
};

describe('generated quiz payload normalization', () => {
  it('drops malformed questions/options while preserving valid math and optional metadata', async () => {
    const warn = vi.fn();
    const aiCall: AICallFn = async () =>
      JSON.stringify([
        {
          id: 'valid-choice',
          type: 'single',
          question: 'Which expression equals four?',
          options: [{ value: 'A', label: '$2+2$' }, { value: 'B' }, { value: 'C', label: '$3+2$' }],
          correctAnswer: 'A',
        },
        { id: 'missing-prompt', type: 'single', options: ['A', 'B'] },
        {
          id: 'valid-text',
          type: 'short_answer',
          question: 'Explain $2+2=4$.',
        },
      ]);

    const content = await generateSceneContent(outline, aiCall, {
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn,
        error: vi.fn(),
      },
    });

    expect(content).toMatchObject({
      questions: [
        {
          id: 'valid-choice',
          question: 'Which expression equals four?',
          options: [
            { value: 'A', label: '$2+2$' },
            { value: 'C', label: '$3+2$' },
          ],
          answer: ['A'],
        },
        {
          id: 'valid-text',
          question: 'Explain $2+2=4$.',
          hasAnswer: false,
        },
      ],
    });
    expect(warn).toHaveBeenCalledWith(
      '[QuizValidation]',
      expect.objectContaining({ questionIndex: 1, field: 'question' }),
    );
  });
});
