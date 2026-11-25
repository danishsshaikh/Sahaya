# Manim implementation progress

## Retired compositor work

- Verified the canonical Sahaya origin and clean base at `cf2fd1e2`. Fetched origin and created `feat/manim-integration`.
- Audited outline streaming and authoring, scene attempts and background polling, the shared DSL, IndexedDB and server persistence, classroom playback, Teaching Voice jobs, export, and Docker and Podman entry points.
- Build the Cairo compiler and validate real output. Then wire the renderer into the existing scene pipeline, playback, editing, and deployment.

- Implemented and exercised the versioned compiler, verified model library, cancellable render queue, media validation, and authenticated artifact proxy.
- Integrated outline selection, generation attempts, timed Teaching Voice, the classroom player, and staged regeneration in Pro mode.
- Added optional Docker, Podman and Quadlet service definitions, preflight checks, and an explicit course-video export limitation.
- Rendered seven preview fixtures plus two standard-quality comparisons. Fixed the NumPy/3D boundary and measured actual encoded segment lengths for cue timing.
- Verified Chrome playback and seeking for all nine videos. Added a JSON round-trip test for the authoritative scene attempt and a player test for navigation and resume.
- Final checks passed for targeted lint and formatting, Docker configuration, and Podman preflight fixtures. Baseline comparison reproduced the existing broad regression failures, and the two retry cases that timed out under full-suite load passed their focused rerun.

- Audited the HPC validation report. Schema-derived guidance now states the font scale, application-owned metadata is stamped, and renderer feedback drives exact-path patch repair.
- Added scene-level failure categories and a retry regression for reloaded partial classrooms. Added a source fingerprint check for DSL and generation builds.
- Validated and rendered the three diffraction demonstrations locally at 720p with the existing limits.

- Confirmed that native tick intervals, kind-only repairs, and serial validation contributed to the second HPC rejection sequence. The original LLM responses remain unavailable.
- Added protocol 3 compilation, collected validation feedback, transactional kind repair, bounded private diagnostics, and same-tab job reattachment with ordered classroom rows.
- Verified seven synthetic compositions against the authoritative validator and rendered one end to end in the offline Cairo smoke test. Live provider generation, Teaching Voice synchronization, and interactive browser checks remain on HPC.

## Native Manim

- Native Manim replacement uses a separate coding agent, pinned documentation, and an administrator-managed gVisor execution boundary. The artifact service remains the storage and playback boundary.

- Retired the JSON planner, validator, patcher and compositor. Native Manim now uses a request-scoped skill, optional Context7 retrieval, a bounded correction loop, and the existing classroom attempts.
- Added owner-scoped native source, cue metadata, isolated preview/final jobs, and measured Teaching Voice retiming. The publisher independently verifies encoded media before publication.
- Added broker capability preflight and the standalone stop/build/restart sequence. Probe results and media checks are tested with local fixtures. Actual university gVisor verification and live generation remain pending.


## Local Bubblewrap execution

- Added an authenticated Unix-socket executor that gates Python on a patched approved runtime, cgroup v1 enrollment and verified isolation. Existing HTTPS gVisor deployments remain optional.
- Added the standalone verification suite and fixed publisher healthcheck permissions. Local tests use mocks and trusted media fixtures. Linux verification and university approval remain prerequisites for live execution.

## Authoring budget and provider failover

- Reproduced the three-reference loop and the 90-second Nemotron Ultra timeout followed by Super HTTP 410. Reference retrieval now batches missing topics and offers one optional discovery turn when two Python submission turns can follow. A reference-only reply after closure ends the loop without another model call.
- The router advances past a retired upstream endpoint. Corrections continue from the working tier within the same deadline. Routed Gemma receives ordinary chat text and Sahaya validates its JSON response locally.
- Fast Refresh review found read-only skill files, an in-memory job store, and renderer writes under the publisher's separate artifact volume. Usage accounting appends to gitignored `data/usage/*.jsonl` in the app checkout. The first production attempt recorded model tokens and neither attempt posted a renderer job. Exact HMR invalidation requires HPC timestamps or watcher events. Fast Refresh configuration remains intact.
- Verified 314 AI, visualization, and scene-job tests. Three classroom PBL tests also fail at the deployed commit. The TypeScript comparison found no new diagnostics.

## Phase deadlines and operator diagnostics

- The last live turn reached Gemma but exhausted the 260-second agent deadline during inference. The scene API also had a separate 280-second timer. A dedicated Manim route can now select local Gemma first, and the self-hosted agent owns one deadline with separate authoring, correction, documentation, preview and final windows.
- Added bounded prompts and completion sizes for the reported 8,192-token context, reasoning and first-token metrics, and separate operator diagnostics for authoring and the authenticated publisher. The operator verified an MP4 through the deployed publisher and Bubblewrap executor.

## Gemma reasoning exhaustion

- The live Manim diagnostic spent three 3,072-token completions without submitting Python. The operator verified that the llama.cpp chat-template switch returned Python in a direct request. Manim now forwards that switch on marked tiers, retries exhaustion once with a smaller prompt, and reports missing reasoning counts separately from known zero. The Node diagnostic command includes the workspace import condition.

## Python extraction and correction

- Reproduced the deployed extractor rejecting valid raw and fenced Python, and forwarding literal escaped line separators from a double-escaped JSON source to Python's syntax check. Valid JSON envelopes round-tripped code with indentation, quotes and LaTeX intact. The original production replies were unavailable, so the exact cause of that source's syntax error remains unconfirmed.
- Text authoring now puts cue metadata in a Python comment and preserves source bytes. Format and Python validation feedback remain separate during bounded corrections. The standalone synthetic diagnostic supports publisher-interpreter static checks, private capture and an optional verified preview.

## Offline API grounding and repair

- Added a reproducible Manim 0.22.1 API index from the hash-pinned wheel and matching upstream docs, with deterministic retrieval before authoring and 12 synthetic cue-scene examples.
- Publisher preflight normalizes a uniquely identifiable cue scene, reuses the native contract, and distinguishes definite API errors from runtime-dependent hints. Repairs preserve the last candidate, use pinned alternatives and have their own bounded call allowance.
- The example library passes static checks. The isolated example verifier and three synthetic model diagnostics are ready for HPC MP4 verification.

## Scaffold, localized repair and model benchmark

- The previous example rank mixed explicit topic matches with generic API overlap. The prompt packer could then drop all examples and replace an oversized candidate with an instruction to rewrite the scene. A realistic synthetic diffraction regression covers both paths. The production reply and exact prompt for the reported classroom request were unavailable.
- Sahaya now supplies the scene wrapper and validates complete candidates after anchored line edits. The publisher supplies categorized syntax locations and resolves public APIs at sanitized runtime error locations.
- The operator benchmark compares approved endpoints on three fixed objectives. Private prompt and candidate capture remains opt-in for synthetic diagnostics. Live comparison and instructional review are pending.
