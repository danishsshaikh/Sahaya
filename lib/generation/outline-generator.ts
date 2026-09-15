import type { SceneOutline } from '@/lib/types/generation';
import {
  isFlowScenesEnabled,
  isInteractiveScenesEnabled,
  isWorkspaceScenesEnabled,
} from '@/lib/config/feature-flags';
import {
  buildInteractiveOutlineTrace,
  classifyInteractiveOutline,
  isAllowedDeterministicInteractiveOutline,
  traceInteractiveCapability,
} from '@/lib/interactive/capabilities';

type OutlineFallbackLogger = {
  warn: (message: string) => void;
};

const noopOutlineFallbackLogger: OutlineFallbackLogger = {
  warn: () => {},
};

function fallbackOutlineToSlide(outline: SceneOutline): SceneOutline {
  const fallback: SceneOutline = { ...outline, type: 'slide' };
  delete fallback.widgetType;
  delete fallback.widgetOutline;
  delete fallback.interactiveConfig;
  delete fallback.pblConfig;
  return fallback;
}

export function sanitizeProceduralSkillOutline(outline: SceneOutline): SceneOutline {
  const widgetOutline = { ...(outline.widgetOutline ?? {}) };
  delete widgetOutline.procedureType;
  delete widgetOutline.task;
  delete widgetOutline.tools;
  delete widgetOutline.steps;
  delete widgetOutline.successCriteria;
  delete widgetOutline.errorConsequences;

  return {
    ...outline,
    type: 'interactive',
    widgetType: 'diagram',
    description: outline.description
      ? `${outline.description} Present this as a process or structure diagram.`
      : 'Present this topic as a process or structure diagram.',
    widgetOutline,
  };
}

export function applyOutlineFallbacks(
  outline: SceneOutline,
  hasLanguageModel: boolean,
  options: { allowProceduralSkill?: boolean; logger?: OutlineFallbackLogger } = {},
): SceneOutline {
  const logger = options.logger ?? noopOutlineFallbackLogger;
  const hasWidgetConfig = outline.widgetType && outline.widgetOutline;

  if (outline.widgetType === 'procedural-skill' && !options.allowProceduralSkill) {
    logger.warn(
      `Procedural-skill outline "${outline.title}" is not enabled, falling back to diagram`,
    );
    return sanitizeProceduralSkillOutline(outline);
  }

  if (outline.type === 'interactive' && !outline.interactiveConfig && !hasWidgetConfig) {
    logger.warn(
      `Interactive outline "${outline.title}" missing interactiveConfig and widget config, falling back to slide`,
    );
    return { ...outline, type: 'slide' };
  }

  if (outline.type === 'pbl' && (!outline.pblConfig || !hasLanguageModel)) {
    logger.warn(
      `PBL outline "${outline.title}" missing pblConfig or languageModel, falling back to slide`,
    );
    return { ...outline, type: 'slide' };
  }

  return outline;
}

export function applySahayaOutlineFeatureFallbacks(
  outline: SceneOutline,
  options: {
    taskEngineMode: boolean;
    hasLanguageModel: boolean;
    logger?: OutlineFallbackLogger;
  },
): SceneOutline {
  const logger = options.logger;
  const packageFallback = applyOutlineFallbacks(outline, options.hasLanguageModel, {
    allowProceduralSkill: options.taskEngineMode,
    ...(logger ? { logger } : {}),
  });

  if (options.taskEngineMode) return packageFallback;

  if (
    packageFallback.type === 'interactive' &&
    packageFallback.widgetType === 'diagram' &&
    packageFallback.widgetOutline?.diagramType === 'flowchart' &&
    !isFlowScenesEnabled()
  ) {
    logger?.warn(`Flow outline "${packageFallback.title}" is disabled, falling back to slide`);
    const fallback = fallbackOutlineToSlide(packageFallback);
    traceInteractiveCapability(
      'interactiveNormalizationFlat',
      buildInteractiveOutlineTrace(fallback, 'generation-fallback-output'),
    );
    return fallback;
  }

  if (
    packageFallback.type === 'interactive' &&
    !isAllowedDeterministicInteractiveOutline(packageFallback) &&
    !isInteractiveScenesEnabled()
  ) {
    const capabilities = classifyInteractiveOutline(packageFallback);
    logger?.warn(
      `Interactive outline "${packageFallback.title}" is disabled (${capabilities.blockedReason ?? 'not allowed'}), falling back to slide`,
    );
    const fallback = fallbackOutlineToSlide(packageFallback);
    traceInteractiveCapability(
      'interactiveNormalizationFlat',
      buildInteractiveOutlineTrace(fallback, 'generation-fallback-output'),
    );
    return fallback;
  }

  if (packageFallback.type === 'pbl' && !isWorkspaceScenesEnabled()) {
    logger?.warn(`PBL outline "${packageFallback.title}" is disabled, falling back to slide`);
    const fallback = fallbackOutlineToSlide(packageFallback);
    traceInteractiveCapability(
      'interactiveNormalizationFlat',
      buildInteractiveOutlineTrace(fallback, 'generation-fallback-output'),
    );
    return fallback;
  }

  return packageFallback;
}
