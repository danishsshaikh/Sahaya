import type { SessionDocumentSource } from '@/lib/types/generation';

export interface DocumentExtractionFailure {
  source: SessionDocumentSource;
  error: string;
}

type DocumentProcessingStatus = NonNullable<SessionDocumentSource['processingStatus']>;

export function updateDocumentSourceProcessing(
  sources: readonly SessionDocumentSource[],
  sourceId: string,
  processingStatus: DocumentProcessingStatus,
  processingError?: string,
): SessionDocumentSource[] {
  return sources.map((source) =>
    source.id === sourceId ? { ...source, processingStatus, processingError } : source,
  );
}

export function removeDocumentSourceById(
  sources: readonly SessionDocumentSource[],
  sourceId: string,
): SessionDocumentSource[] {
  return sources.filter((source) => source.id !== sourceId);
}

export function hasUnresolvedDocumentSources(sources: readonly SessionDocumentSource[]): boolean {
  return sources.some(
    (source) => source.processingStatus === 'failed' || source.processingStatus === 'processing',
  );
}

export async function extractDocumentBatch<T>(
  sources: readonly SessionDocumentSource[],
  extract: (source: SessionDocumentSource) => Promise<T>,
): Promise<{
  successes: Array<{ source: SessionDocumentSource; value: T }>;
  failures: DocumentExtractionFailure[];
}> {
  const settled = await Promise.allSettled(sources.map((source) => extract(source)));
  const successes: Array<{ source: SessionDocumentSource; value: T }> = [];
  const failures: DocumentExtractionFailure[] = [];

  settled.forEach((result, index) => {
    const source = sources[index];
    if (result.status === 'fulfilled') {
      successes.push({ source, value: result.value });
      return;
    }

    failures.push({
      source,
      error: result.reason instanceof Error ? result.reason.message : 'Document extraction failed',
    });
  });

  return { successes, failures };
}
