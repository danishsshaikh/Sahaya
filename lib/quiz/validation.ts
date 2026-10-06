import { createLogger } from '@/lib/logger';
import type { QuizQuestion } from '@/lib/types/stage';

const log = createLogger('QuizValidation');
const QUESTION_TYPES = new Set<QuizQuestion['type']>(['single', 'multiple', 'short_answer']);

export interface QuizValidationIssue {
  sceneId: string;
  questionIndex: number;
  field: string;
  reason: string;
}

type ReportIssue = (issue: QuizValidationIssue) => void;

function defaultReport(issue: QuizValidationIssue): void {
  log.warn('[QuizValidation]', issue);
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function normalizeQuizQuestions(
  input: unknown,
  sceneId: string,
  report: ReportIssue = defaultReport,
): QuizQuestion[] {
  if (!Array.isArray(input)) {
    report({ sceneId, questionIndex: -1, field: 'questions', reason: 'not-an-array' });
    return [];
  }

  return input.flatMap((candidate, questionIndex): QuizQuestion[] => {
    if (!candidate || typeof candidate !== 'object') {
      report({ sceneId, questionIndex, field: 'question', reason: 'not-an-object' });
      return [];
    }

    const raw = candidate as Record<string, unknown>;
    const id = nonemptyString(raw.id);
    const question = nonemptyString(raw.question);
    const type = QUESTION_TYPES.has(raw.type as QuizQuestion['type'])
      ? (raw.type as QuizQuestion['type'])
      : undefined;
    if (!id || !question || !type) {
      report({
        sceneId,
        questionIndex,
        field: !id ? 'id' : !question ? 'question' : 'type',
        reason: 'missing-or-invalid-required-field',
      });
      return [];
    }

    let options: QuizQuestion['options'];
    if (type !== 'short_answer') {
      if (!Array.isArray(raw.options)) {
        report({ sceneId, questionIndex, field: 'options', reason: 'missing-choice-options' });
        return [];
      }
      options = raw.options.flatMap((option, optionIndex) => {
        if (typeof option === 'string' && option.trim()) {
          return [{ value: String.fromCharCode(65 + optionIndex), label: option }];
        }
        if (!option || typeof option !== 'object') {
          report({
            sceneId,
            questionIndex,
            field: `options[${optionIndex}]`,
            reason: 'invalid-option',
          });
          return [];
        }
        const record = option as Record<string, unknown>;
        const label = nonemptyString(record.label) ?? nonemptyString(record.text);
        if (!label) {
          report({
            sceneId,
            questionIndex,
            field: `options[${optionIndex}].label`,
            reason: 'missing-option-text',
          });
          return [];
        }
        return [
          {
            value: nonemptyString(record.value) ?? String.fromCharCode(65 + optionIndex),
            label,
          },
        ];
      });
      if (options.length < 2) {
        report({ sceneId, questionIndex, field: 'options', reason: 'no-renderable-options' });
        return [];
      }
    }

    const rawAnswer = raw.answer ?? raw.correctAnswer ?? raw.correct_answer;
    const answer =
      rawAnswer === undefined || rawAnswer === null
        ? undefined
        : (Array.isArray(rawAnswer) ? rawAnswer : [rawAnswer]).filter(
            (value): value is string => typeof value === 'string' && value.length > 0,
          );
    if (rawAnswer !== undefined && rawAnswer !== null && answer?.length === 0) {
      report({ sceneId, questionIndex, field: 'answer', reason: 'invalid-answer-metadata' });
    }

    const analysis = nonemptyString(raw.analysis);
    const commentPrompt = nonemptyString(raw.commentPrompt);
    if (raw.analysis != null && !analysis) {
      report({ sceneId, questionIndex, field: 'analysis', reason: 'invalid-optional-text' });
    }
    if (raw.commentPrompt != null && !commentPrompt) {
      report({ sceneId, questionIndex, field: 'commentPrompt', reason: 'invalid-optional-text' });
    }

    return [
      {
        id,
        type,
        question,
        ...(options ? { options } : {}),
        ...(answer && answer.length > 0 ? { answer } : {}),
        ...(analysis ? { analysis } : {}),
        ...(commentPrompt ? { commentPrompt } : {}),
        ...(typeof raw.hasAnswer === 'boolean' ? { hasAnswer: raw.hasAnswer } : {}),
        ...(typeof raw.points === 'number' && Number.isFinite(raw.points) && raw.points > 0
          ? { points: raw.points }
          : {}),
      },
    ];
  });
}
