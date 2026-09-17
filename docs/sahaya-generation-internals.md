# Sahaya Generation Internals

This document records the current Sahaya/OpenMAIC generation path as implemented in
this repository. It is an implementation inventory, not a product promise.

## Entry Points

- `app/api/generate/scene-outlines-stream/route.ts` streams scene outlines from a
  course request. It resolves the model for the outline stage, prepares optional
  vision inputs, and calls `streamLLM`.
- `app/api/generate/scene-content/route.ts` generates one scene's content from
  an outline. Slide, quiz, interactive/widget, and PBL content are delegated to
  `@openmaic/generation`.
- `app/api/generate/scene-actions/route.ts` generates playback/narration actions
  for one scene and assembles the complete scene.
- `lib/server/classroom-generation.ts` is the one-shot classroom path used by
  server-side generation. It generates outlines, optional generated agents,
  scene content, scene actions, media, TTS, and then persists the classroom.
- `lib/server/agent-runtime/generation-tools.ts` and
  `lib/server/agent-runtime/generation-ai-call.ts` expose generation to the
  Workbench/agent runtime while preserving the same `AICallFn` package seam.

## LLM Boundary

All ordinary server LLM calls should pass through `lib/ai/llm.ts`:

- `callLLM` wraps Vercel AI SDK `generateText`.
- `streamLLM` wraps Vercel AI SDK `streamText`.
- Thinking/reasoning provider options are resolved centrally in this file.
- Usage capture is recorded centrally from `callLLM` and `streamLLM`.
- `lib/server/llm-router.ts` can replace the selected SDK model at runtime with
  the Sahaya primary/fallback router when `LLM_ROUTER_ENABLED=true`.

The router now exposes privacy-safe typed route telemetry through
`LLMRoutingPolicy.onRouteEvent`. Timing records use this callback when available
and do not include prompts, user text, model responses, or document content.

## Scene Generation Pipeline

`packages/@openmaic/generation/src/scene-generator.ts` owns the package-level
content/action generation primitives:

1. `generateSceneContent` dispatches by outline type.
2. Slide content uses the `slide-content` prompt, parses JSON, normalizes DSL
   elements, renders dedicated `latex` elements through KaTeX, resolves image
   ids, normalizes generated video references, assigns unique ids, and repairs
   unsafe geometry through `repairGeneratedSlideLayout`.
3. Quiz content uses the `quiz-content` prompt and normalizes generated answers.
4. Interactive content chooses one of simulation, diagram, code, game,
   visualization3d, or procedural-skill prompts, then post-processes HTML and
   extracts widget config where applicable.
5. PBL content uses the PBL v2 single-call planner first and may fall back to
   the app-owned loop planner when the host supplies `pblLoopFallback`.
6. `generateSceneActions` dispatches action prompts for slide, quiz,
   interactive, and PBL scenes.

`packages/@openmaic/generation/src/scene-builder.ts` converts generated
primitives plus actions into the persisted scene contract. Slide canvases use
`viewportSize: 1000` and `viewportRatio: 0.5625`.

## Math Rendering

Generated slides can contain math in two forms:

- Dedicated `latex` elements: rendered during scene generation with KaTeX and
  persisted as `html`.
- Inline/block LaTeX embedded in ordinary text: rendered in
  `packages/@openmaic/renderer/src/utils/inlineMarkdown.ts` and mirrored in the
  classroom renderer copy at
  `components/slide-renderer/components/element/TextElement/inlineMarkdown.ts`.

The inline formatter is conservative so currency and shell/code-looking values
such as `$25`, `US$100`, `$HOME`, and `${PATH}` remain ordinary text. Very large
malformed delimited blocks collapse to a small unavailable-formula placeholder
instead of exposing raw model output across the slide.

## Layout Repair

Slide prompts ask the model for non-overlapping layout, but the deterministic
guard is `packages/@openmaic/generation/src/slide-layout.ts`.

The repair pass only applies to generated slide `PPTElement[]` geometry. It:

- detects elements outside the 1000 x 562.5 safe area;
- detects content placed in the reserved title/header band;
- detects substantial box overlaps;
- detects duplicate generated title candidates;
- keeps the implementation payload intact and reflows element boxes instead of
  deleting content;
- leaves non-slide scene types untouched.

When a layout is unsafe, one title/header is placed in the title band and the
remaining visible box elements are reflowed into a bounded grid below it.

## Timing Logs

Timing records are emitted from `lib/server/generation-timing.ts`.

- `[SceneGenerationTiming]` records scene content/action phase duration, scene
  type, stage/outline ids, element/action counts when available, retry attempts,
  and router selection metadata when the router supplies it.
- `[CourseGenerationTiming]` records one-shot classroom duration, generated scene
  counts, failed scene count, aggregate content/action duration, and optional
  media/TTS durations.

The timing payload deliberately avoids prompts, responses, student/faculty text,
document snippets, image bytes, and API keys.

## Prompt Inventory

Package prompts loaded through `packages/@openmaic/generation/src/prompts`:

- `requirements-to-outlines`: outline generation.
- `slide-content`: slide canvas content.
- `quiz-content`: quiz payload content.
- `simulation-content`: simulation widget HTML.
- `diagram-content`: diagram widget HTML.
- `code-content`: code widget HTML.
- `game-content`: game widget HTML.
- `visualization3d-content`: 3D visualization widget HTML.
- `procedural-skill-content`: vocational/procedural task content.
- `slide-actions`: slide playback/narration actions.
- `quiz-actions`: quiz actions.
- `interactive-actions`: widget actions.
- `pbl-actions`: PBL actions.

Package snippets:

- `json-output-rules`
- `image-instructions`
- `media-safety-guidelines`
- `slide-image-instructions`
- `slide-generated-image-instructions`
- `slide-video-instructions`
- `video-instructions`

PBL package prompts:

- `planner-system`
- `planner-single-call-system`
- `planner-scenario-single-call-system`

App/runtime prompt builders outside the package include:

- `lib/server/search-query-builder.ts` for web-search query rewriting.
- `app/api/generate/agent-profiles/route.ts` and
  `lib/server/classroom-generation.ts` for generated classroom agents.
- `lib/pbl/v2/agents/planner.ts` and
  `packages/@openmaic/generation/src/pbl/planner-single-call.ts` for PBL
  project planning.
- `lib/pbl/v2/agents/instructor.ts` for instructor turns.
- `lib/pbl/v2/agents/simulator.ts` for scenario role-play simulation and
  narrator turns.
- `lib/pbl/v2/agents/evaluator.ts` plus
  `lib/pbl/v2/operations/runtime/eval-prompts.ts` for task, milestone, and
  final evaluation.
- `lib/server/agent-runtime/runner-contract.ts`,
  `lib/server/agent-runtime/roster-tools.ts`, and
  `lib/server/agent-runtime/skills.ts` for Workbench agent-runtime prompts.
- `lib/chat/pi/*` for Pi/native child-director prompts and tool calls.

## LangChain / LangGraph Audit

LangChain and LangGraph are present dependencies in `package.json`:

- `@langchain/core`
- `@langchain/langgraph`

Actual first-party use found in this repository:

- `lib/orchestration/ai-sdk-adapter.ts` adapts the Vercel AI SDK model boundary
  into a LangChain `BaseChatModel` while still routing through `callLLM` and
  `streamLLM`.
- `lib/orchestration/director-graph.ts` uses LangGraph `Annotation`,
  `StateGraph`, `START`, and `END` for the classroom multi-agent director graph.
- `lib/orchestration/stateless-generate.ts` invokes the orchestration flow.

The main classroom generation path is not a LangChain chain. It is a TypeScript
pipeline around prompt templates, `AICallFn`, Vercel AI SDK wrappers, retry
helpers, and deterministic post-processing.

The PBL v2 runtime is also not LangGraph-based. Its planner/instructor/simulator
and evaluator agents use Vercel AI SDK tool calling and the central
`callLLM`/`streamLLM` wrappers.

## Agent Meanings

The codebase uses "agent" for several different surfaces:

- classroom roster agents: teacher/assistant/student personas used in prompts
  and narration;
- Workbench runtime agents/tools under `lib/server/agent-runtime`;
- PBL v2 instructor/simulator/evaluator roles;
- LangGraph director orchestration under `lib/orchestration`.

These are related product concepts but not one shared agent framework.
