# README diagram design

Date: 2026-08-10

## Outcome

Add two checked-in diagrams to the public README using the same presentation pattern as Valor: centered visual assets for the system architecture and delivery pipeline, followed by links to deeper technical documentation.

## Approaches considered

1. **Editable SVG assets — selected.** SVG keeps technical labels exact, remains sharp on GitHub, supports accessible descriptions, and can be maintained without a proprietary design tool.
2. **Rendered Mermaid images.** This would reduce drawing work, but the visual hierarchy would remain close to the existing architecture guide and would not provide the polished README presentation requested.
3. **Generated bitmap artwork.** This can provide more decorative styling, but generated text and connector placement are unreliable for a safety-sensitive architecture diagram.

## Assets

### System architecture

`docs/assets/architecture.svg` is a vertical diagram with five ownership layers:

1. paired private Telegram owner;
2. Telegram I/O bridge;
3. durable SQLite control state and outbox;
4. single leased executor;
5. BB execution, split into the hidden controller thread, fresh pipeline threads, and the managed Git worktree.

The diagram must make clear that the I/O bridge records and delivers work but does not spawn sessions, and that the worktree—not a BB thread—is the code/filesystem mutation boundary.

### Reviewed delivery pipeline

`docs/assets/reviewed-pipeline.svg` is a wide, three-lane diagram. It shows the implemented path from intake through planning, critique, build, deterministic testing, fresh review, documentation, final validation and review, owner approval, merge, deployment, canary, and completion.

It also shows:

- critique returning to planning;
- failed validation or requested review changes entering the bounded patch loop;
- invalid or exhausted evidence ending in a blocked state;
- owner approval occurring before merge;
- merge, deployment, and canary as separate stages.

## README placement

- Add an `Architecture` section after `How it works` and embed `docs/assets/architecture.svg` at a bounded width.
- Replace the plain-text pipeline line with `docs/assets/reviewed-pipeline.svg` while retaining the explanatory failure-path paragraph.
- Use descriptive alternative text and ordinary relative paths so both assets render on GitHub forks.

## Visual system

- Use a white canvas for predictable GitHub rendering.
- Use slate text and connectors, blue for I/O, violet for BB execution, amber for owner gates/remediation, green for completed stages, and red only for blocked outcomes.
- Use system UI fonts, rounded cards, restrained shadows, and no external assets.
- Keep labels readable at the README display widths.

## Verification

- Parse both SVGs as XML.
- Render both SVGs to raster previews with an available local renderer and inspect them visually.
- Validate all README-relative links and image targets.
- Verify the diagram stage ordering against `src/domain/pipeline-graph.ts`.
- Run `git diff --check`, `npm run check`, and `bb plugin types --check .`.
- Commit only the two SVG assets, README, and this diagram design/plan; preserve unrelated runtime and test changes already in the worktree.
