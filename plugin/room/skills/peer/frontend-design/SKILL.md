---
name: frontend-design
description: "Use before you build or change a screen, page or component that a person looks at and operates: structure before decoration, the material states, responsive behavior, the repository's design language. Skip it for copy-only edits, one design token, or UI logic that renders nothing. Peer skill for a writable UI scope."
---

# Frontend Design

Build the requested product experience using the repository's design language. This skill owns visual and interaction quality, not product discovery or architecture.

Before editing, identify the audience, primary job, information density, existing
components, and material states. Make routine visual choices locally. Ask only when
different choices would change the product contract.

Prioritize usable structure before decoration:

- expose the primary workflow and action
- preserve semantic controls, keyboard and focus behavior
- handle loading, empty, error, disabled, selected, and recovery states that belong to the flow
- prevent clipping, overlap, hidden actions, and unintended layout shifts
- use domain content and established assets instead of generic card grids, gradients, glass, blobs, or oversized marketing headings

Inspect the rendered result at the representative viewports required by the change
and exercise the primary affected workflow. Do not add a separate verification
ceremony or unrelated cleanup. If rendered inspection is unavailable, report that
limitation without claiming visual completion.
