# Agent Surfaces

Pilot is surface-neutral. It should work for Codex, Claude Code, and generic
agent runners without forking workflow policy.

## Rule

Surface files are adapters into the same repo contract.

| Surface | Native entrypoint | Role |
| --- | --- | --- |
| Codex | `AGENTS.md` | Cross-agent policy, route selection, gates, validation commands. |
| Claude Code | `CLAUDE.md` | Claude Code native instructions, local coding discipline, architecture notes. |
| Generic CLI agent | `AGENTS.md` + `AGENT_USAGE.md` | Explicit loading path for agents without native instruction discovery. |
| Skills | `skills/*/SKILL.md` | Execution guides for specific routes. |
| Hooks | `.claude/hooks`, `.codex/config.toml`, CI jobs | Enforcement or guardrails, not workflow authority. |

## Authority Order

When instructions conflict, resolve them in this order:

1. Explicit human instruction for the current task.
2. `workflow.yaml`, `states.yaml`, and `labels.yaml`.
3. `AGENTS.md`.
4. `CLAUDE.md`.
5. Repo-local skills.
6. Generic skills.

Surface-specific files may add commands, local conventions, or tool ergonomics.
They must not bypass readiness labels, spec approval, final review, merge,
release, or security human gates.

## Adoption Pattern

For a repo that supports both Codex and Claude Code:

- Keep `AGENTS.md` short and policy-oriented.
- Keep `CLAUDE.md` focused on coding discipline and repo architecture.
- Make both files point to `workflow.yaml`, `states.yaml`, `labels.yaml`,
  `AGENT_USAGE.md`, and repo-local skills.
- Keep duplicate rules minimal; duplicated rules drift.

## Anti-Patterns

- Codex gets one workflow while Claude Code gets another.
- `CLAUDE.md` grants implementation or merge authority that `workflow.yaml`
  does not grant.
- Hooks silently rewrite readiness state.
- Skills override human gates.
- Chat history becomes the only source of truth.
