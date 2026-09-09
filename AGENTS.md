# AGENTS.md

`llm-runtime-dock` is a local OpenAI/Anthropic-compatible LLM gateway that manages
runtime processes and switches models behind one endpoint.

This file is a pointer, not a second copy of anything. Three places hold the
truth:

- **[`docs/README.md`](docs/README.md)** is the specification and the source of
  truth for behaviour. It indexes every section and maps the `§N` numbers the
  code comments cite.
- **[`CLAUDE.md`](CLAUDE.md)** holds the conventions that are not obvious from
  the code: the arrow-function and no-class rules ESLint enforces, the
  cross-platform rules, the packaging, dependency and version-generation rules,
  and the invariants that are easy to break. **Read it before editing any TypeScript.**
- **[`README.md`](README.md)** is the user-facing manual.

## Extending the project

Two procedures are written down as skills, loadable from either tool:

- [`.claude/skills/add-runtime-adapter/SKILL.md`](.claude/skills/add-runtime-adapter/SKILL.md)
  - support another inference backend, or decide the declarative `custom` adapter
    is enough.
- [`.claude/skills/add-agent-integration/SKILL.md`](.claude/skills/add-agent-integration/SKILL.md)
  - make `lrd apply` write the gateway into another coding agent's configuration.

## Verifying a change

`pnpm install && pnpm -r run build && pnpm typecheck && pnpm lint && pnpm test`.
The longer form, with what each failure actually means, is in
[`.claude/commands/verify-extension.md`](.claude/commands/verify-extension.md).
