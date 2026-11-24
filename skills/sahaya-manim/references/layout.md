# Layout and animations

Use `VGroup.arrange`, `next_to`, and `to_edge` to separate text from the diagram. Scale a group together if it approaches the frame. Check the layout after transformations. Use `Create` for curves, `Write` for equations, and `FadeIn` for supporting labels. Animate one mutating operation per object in a single `play`. Use successive plays when the same target needs two changes. Use `ValueTracker` and a pure updater for continuous change, then clear the updater when it is no longer needed.
