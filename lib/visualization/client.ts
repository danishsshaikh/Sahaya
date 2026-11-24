'use client';

import { useEffect, useState } from 'react';

export function visualizationMediaUrl(artifactId: string, file: 'video.mp4' | 'poster.jpg') {
  return `/api/visualizations/artifacts/${encodeURIComponent(artifactId)}/${file}`;
}

export function useVisualizationCapability() {
  const [capability, setCapability] = useState<{ available: boolean; reason?: string }>();
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/visualizations/capability', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Visualization capability unavailable');
        return response.json() as Promise<{ available: boolean; reason?: string }>;
      })
      .then(setCapability)
      .catch(() => {
        if (!controller.signal.aborted) {
          setCapability({ available: false, reason: 'Could not check the visualization service.' });
        }
      });
    return () => controller.abort();
  }, []);
  return capability;
}
