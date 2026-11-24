# Narration timing

Use sequential `with self.cue("id"):` blocks. Each block needs at least one visible animation or deliberate hold. Create all animated media inside cues, including camera moves. Cue IDs must match the metadata in order. Within a block, `self.cue_duration("id")` returns the measured narration duration in seconds when available, or zero in the first pass. Use it to distribute time when useful. The adapter pads shorter visuals to fit speech. Avoid automatic speed-ups that would hide an explanation. The final cue times come from emitted Cairo frames.
