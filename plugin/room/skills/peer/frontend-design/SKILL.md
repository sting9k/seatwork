---
name: frontend-design
description: "Use before you build or change a screen, page or component that a person looks at and operates: structure before decoration, the material states, responsive behavior, the repository's design language. Skip it for copy-only edits, one design token, or UI logic that renders nothing. Peer skill for a writable UI scope."
---

# Frontend Design

Build the requested product experience in the repository's design language. This skill owns
visual and interaction quality, not product discovery or architecture.

Before editing, identify the audience, the primary job, the information density, the existing
components, and the material states.

Usable structure before decoration:

- expose the primary workflow and action
- preserve semantic controls, keyboard and focus behavior
- handle loading, empty, error, disabled, selected, and recovery states that belong to the flow
- prevent clipping, overlap, hidden actions, and unintended layout shifts
- use domain content and established assets instead of generic card grids, gradients, glass,
  blobs, or oversized marketing headings

Inspect the rendered result at the viewports the change must serve and exercise the primary
affected workflow, with no separate verification ceremony and no unrelated cleanup; a visual
claim with no rendered inspection behind it is `not checked`.
