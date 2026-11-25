function positiveInt(name: string, fallback: number, max: number) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

export function manimAgentBudget() {
  const seconds = (name: string, fallback: number, max = 900) =>
    1000 * positiveInt(`MANIM_AGENT_${name}_SECONDS`, fallback, max);
  // The managed scene-content route has a 300-second platform limit. The HPC
  // deployment runs Next.js on its own server and uses the full agent deadline.
  const overallMs = Math.min(
    seconds('DEADLINE', 900),
    process.env.VERCEL === '1' ? 275_000 : Infinity,
  );
  const contextTokens = positiveInt('MANIM_AGENT_CONTEXT_TOKENS', 8192, 131_072);
  return {
    overallMs,
    documentationMs: seconds('DOCUMENTATION', 8, 30),
    inferenceMs: seconds('INFERENCE', 300),
    remoteInferenceMs: seconds('REMOTE_INFERENCE', 45),
    authoringMs: seconds('AUTHORING', 480),
    correctionMs: seconds('CORRECTION', 220),
    previewMs: seconds('PREVIEW', 90, 300),
    finalMs: seconds('FINAL', 160, 300),
    contextTokens,
    completionTokens: Math.min(
      positiveInt('MANIM_AGENT_COMPLETION_TOKENS', 3072, 16_384),
      Math.floor(contextTokens / 2) || 1,
    ),
    promptBytes: positiveInt('MANIM_AGENT_PROMPT_BYTES', 10_000, 48_000),
  };
}

// Small explicit deadlines (including managed deployments) still divide time
// between phases. At the HPC default these reserve both full render windows.
export function manimRenderWindows(
  config: ReturnType<typeof manimAgentBudget>,
  previewOnly: boolean,
) {
  return {
    previewMs: Math.min(config.previewMs, Math.floor(config.overallMs * 0.2)),
    finalMs: previewOnly ? 0 : Math.min(config.finalMs, Math.floor(config.overallMs * 0.3)),
  };
}
