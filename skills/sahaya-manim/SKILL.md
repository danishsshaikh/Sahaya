---
name: sahaya-manim
description: Create and correct native Manim Community v0.22.1 educational visualizations with named cues and isolated Cairo renders.
compatibility: Manim Community v0.22.1, Cairo, Sahaya Manim execution protocol 1
metadata:
  version: '1.0.0'
---

Generate a complete Python module defining one `GeneratedScene` that inherits from `CueScene`, `CueMovingCameraScene`, or `CueThreeDScene` from `sahaya_timing`. Use native Manim objects, animations, equations, updaters, and coordinate systems. Render every animation and wait inside a `with self.cue("cue-id"):` block. Supply the same ordered IDs and spoken narration in the response metadata. Use a small number of purposeful cues.

Treat faculty material as the educational source. Preserve quantities, units, and assumptions. Label illustrative diagrams in the narration or scene. Use numerical assertions for important relationships when practicable. Render success does not establish a scientific claim.

Use high contrast, consistent colors, a readable font hierarchy, and safe margins. Let a visual relationship appear before introducing its label. Build a different composition for each concept. Avoid simultaneous animations that mutate the same object. Keep equations concise and prefer simple MathTex syntax.

Use Manim Community APIs, Cairo-compatible constructs, and local mathematical functions. The workspace has no network, assets, audio, or external packages beyond the image. Sahaya handles narration separately and supplies measured cue durations on retiming. Do not install packages, invoke external programs, import system modules, modify renderer configuration, or use arbitrary files.

Use the pinned API signatures and examples selected for the task. When the controller offers reference retrieval, use `look_up_manim` for an exact symbol or concept, or request missing essential reference topics together. Once the controller requests code, submit the complete module and cue metadata. In text mode, write the cue array in the opening `# sahaya-cues:` comment and keep code on actual Python lines. During repair, use the reported lines and verified APIs and preserve working cues and teaching content.
