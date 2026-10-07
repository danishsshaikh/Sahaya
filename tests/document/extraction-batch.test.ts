import { describe, expect, it, vi } from 'vitest';
import {
  extractDocumentBatch,
  hasUnresolvedDocumentSources,
  removeDocumentSourceById,
  updateDocumentSourceProcessing,
} from '@/lib/document/extraction-batch';
import type { SessionDocumentSource } from '@/lib/types/generation';

function source(id: string, order: number, mimeType = 'application/pdf'): SessionDocumentSource {
  return {
    id,
    name: `${id}.${mimeType.includes('presentation') ? 'pptx' : 'pdf'}`,
    size: 1024,
    order,
    storageKey: `blob-${id}`,
    mimeType,
  };
}

describe('document extraction batch', () => {
  it('preserves successful PDF and PPTX results when one sibling parser fails', async () => {
    const pdf = source('pdf-a', 1);
    const failed = source('pdf-b', 2);
    const pptx = source(
      'slides',
      3,
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    const extract = vi.fn(async (item: SessionDocumentSource) => {
      if (item.id === failed.id) throw new Error('parser timeout');
      return { text: `content:${item.id}` };
    });

    const result = await extractDocumentBatch([pdf, failed, pptx], extract);

    expect(result.successes).toEqual([
      { source: pdf, value: { text: 'content:pdf-a' } },
      { source: pptx, value: { text: 'content:slides' } },
    ]);
    expect(result.failures).toEqual([{ source: failed, error: 'parser timeout' }]);
    expect(extract).toHaveBeenCalledTimes(3);
  });

  it('keeps source identity when duplicate display names are processed independently', async () => {
    const first = { ...source('source-a', 1), name: 'lecture.pdf' };
    const second = { ...source('source-b', 2), name: 'lecture.pdf' };

    const result = await extractDocumentBatch([first, second], async (item) => item.id);

    expect(result.successes.map(({ source: item, value }) => [item.id, value])).toEqual([
      ['source-a', 'source-a'],
      ['source-b', 'source-b'],
    ]);
  });

  it('moves only the retried source through processing and ready states', () => {
    const ready = { ...source('ready', 1), processingStatus: 'ready' as const };
    const failed = {
      ...source('failed', 2),
      processingStatus: 'failed' as const,
      processingError: 'parser timeout',
    };

    const processing = updateDocumentSourceProcessing([ready, failed], failed.id, 'processing');
    expect(processing).toEqual([
      ready,
      { ...failed, processingStatus: 'processing', processingError: undefined },
    ]);
    expect(hasUnresolvedDocumentSources(processing)).toBe(true);

    const retried = updateDocumentSourceProcessing(processing, failed.id, 'ready');
    expect(retried).toEqual([
      ready,
      { ...failed, processingStatus: 'ready', processingError: undefined },
    ]);
    expect(hasUnresolvedDocumentSources(retried)).toBe(false);
  });

  it('removes only the failed source by stable ID', () => {
    const first = { ...source('source-a', 1), name: 'lecture.pdf' };
    const failed = {
      ...source('source-b', 2),
      name: 'lecture.pdf',
      processingStatus: 'failed' as const,
    };

    expect(removeDocumentSourceById([first, failed], failed.id)).toEqual([first]);
  });
});
