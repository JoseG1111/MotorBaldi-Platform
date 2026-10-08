# MotorBaldi execution rules

- Inspect repository reality before assuming state; repository evidence overrides stale notes.
- Use `docs/ai/` for project continuity. For “Continue MotorBaldi”, “continue”, “resume”, or autonomous work, follow `docs/ai/EXECUTION_PLAN.md` and its recovery loop.
- Respect accepted architecture decisions and the detailed canonical docs they link to.
- Never mark a checkpoint `VERIFIED` without evidence; keep execution state synchronized with reality.
- Never expose or commit secrets, or weaken security to make progress.
- Continue through eligible checkpoints and stop only at the human-action boundaries defined in `docs/ai/EXECUTION_PLAN.md`.
