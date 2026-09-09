import type {
  AdapterProbeOutcome,
  ProbeAnswers,
  RuntimeAdapter,
  AmbiguousEntry,
  StaleEntry,
} from '@llm-runtime-dock/core';
import {
  cliError,
  configWriteTarget,
  probeAdapter,
  readTextIfExists,
  renderDiscoveredModels,
  resolveProbeUrl,
  saveDiscovery,
} from '@llm-runtime-dock/core';
import type { CliContext } from '../context.js';

/**
 * `lrd probe` (spec §22, §27).
 *
 * Discovery asks the backends themselves what they serve. It needs no gateway
 * and no configuration — it is how a configuration gets written in the first
 * place. Probing is read-only, with exactly one flag-gated exception: `--start`
 * brings up a server the probe has just found down, and probes again.
 */

export interface ProbeCommandOptions {
  readonly url?: string;
  readonly host?: string;
  readonly port?: number;
  readonly apiKeyEnv?: string;
  readonly save?: boolean;
  readonly dryRun?: boolean;
  /** Delete configured models the probe did not find, without asking (§22). */
  readonly force?: boolean;
  /** Start a backend the probe just found down, then probe it again (§22). */
  readonly start?: boolean;
  readonly interactive?: boolean;
}

/**
 * One thing to probe: an adapter, and the `runtimes:` key its result belongs to.
 *
 * The key matters even before any configuration exists, because it is what
 * `--save` writes and what ownership is scoped to. With nothing declared it is
 * the adapter id, which is also the entry `--save` creates.
 */
interface ProbeSubject {
  readonly runtimeId: string;
  readonly adapter: RuntimeAdapter;
  readonly host?: string;
  readonly port?: number;
  readonly apiKeyEnv?: string;
  /** Declared, so an unreachable one is a configured endpoint rather than a guess. */
  readonly declared: boolean;
  /**
   * Whether a sweep may include this subject (§22). `false` only ever comes from
   * `discovery: false` on a declared runtime; a subject built from an adapter is
   * always `true`, because nothing declared it and so nothing excluded it.
   */
  readonly discoverable: boolean;
}

export const runProbe = async (
  context: CliContext,
  target: string | undefined,
  options: ProbeCommandOptions,
): Promise<void> => {
  if (options.force === true && options.save !== true) {
    // --force only decides what --save deletes. Accepting it silently on a
    // read-only probe would suggest it did something.
    throw cliError('CONFIG_INVALID', '--force applies to --save', {
      hint: 'run `lrd probe <runtime> --save --force`',
    });
  }

  let subjects = selectSubjects(context, target);

  // Say what was left out, once. A runtime silently missing from a probe is a
  // mystery; naming it and the flag that did it is not a status check, it is the
  // difference between "skipped" and "broken".
  const excluded = excludedRuntimes(context, subjects);
  if (excluded.length > 0) {
    context.err(
      context.theme.muted(
        `skipping ${excluded.join(', ')} (discovery: false) — name one to probe it anyway`,
      ),
    );
  }
  if (subjects.length === 0) {
    context.err(context.theme.muted('nothing to probe'));
    return;
  }

  if (options.url || options.host || options.port !== undefined) {
    if (subjects.length !== 1) {
      // Not "a single adapter": two declared runtimes may share one, and
      // pointing both at one port would probe it twice and write the second
      // answer over the first.
      throw cliError('CONFIG_INVALID', '--url, --host and --port apply to a single probe target', {
        hint: `name one, e.g. \`lrd probe ${subjects[0]?.runtimeId ?? '<runtime>'} --port=8000\``,
      });
    }
  }

  let answersFor = new Map<string, ProbeAnswers>();
  if (options.interactive === true) {
    answersFor = await ask(context, subjects, options);
    subjects = subjects.filter((subject) => answersFor.has(subject.runtimeId));
    if (subjects.length === 0) {
      context.err(context.theme.muted('nothing selected'));
      return;
    }
  }

  const outcomes: AdapterProbeOutcome[] = [];
  for (const subject of subjects) {
    const answers = answersFor.get(subject.runtimeId) ?? {};
    let outcome = await probeOne(context, subject, options, answers);

    // Read-only, except here. Only a runtime the probe just found *down* is
    // started: `auth_required` means it is running and wants a credential, and
    // the two new outcomes have no server of ours to start (§22).
    const wantsStart = options.start === true || answers.start === true;
    if (wantsStart && outcome.result.status === 'not_running') {
      outcome = await startAndReprobe(context, subject, options, answers);
    }
    outcomes.push(outcome);
  }

  if (options.save === true) {
    await save(context, outcomes, options);
    return;
  }

  if (context.options.json) {
    context.json(outcomes);
    return;
  }
  report(context, outcomes);
  const owners = configuredOwners(context);
  reportPreview(context, outcomes, subjects, owners);

  if (options.interactive === true && context.probeSavePrompt) {
    const preview = renderDiscoveredModels(outcomes, owners);
    if (preview) {
      const path = configWriteTarget(context.configLocation());
      if (await context.probeSavePrompt({ path, preview: preview.yaml })) {
        await save(context, outcomes, { ...options, save: true });
      }
    }
  }
};

/** Probe one subject, resolving its endpoint and credential by the §22 ladder. */
const probeOne = async (
  context: CliContext,
  subject: ProbeSubject,
  options: ProbeCommandOptions,
  answers: ProbeAnswers,
): Promise<AdapterProbeOutcome> => {
  return probeAdapter(subject.adapter, {
    runtimeId: subject.runtimeId,
    url: options.url,
    host: answers.host ?? options.host ?? subject.host,
    port: answers.port ?? options.port ?? subject.port,
    apiKey: resolveProbeKey(context, subject, options, answers),
    logger: context.logger,
  });
};

/**
 * Bring a backend up and probe it again (§22).
 *
 * The re-probe uses the URL `startServer` reported, not the one that was asked
 * for: a runtime may honour its own configured port instead, and probing the
 * wrong one would report "not running" about a server that had just started.
 */
const startAndReprobe = async (
  context: CliContext,
  subject: ProbeSubject,
  options: ProbeCommandOptions,
  answers: ProbeAnswers,
): Promise<AdapterProbeOutcome> => {
  const adapter = subject.adapter;
  if (!adapter.startServer) {
    // Adapter-specific *why* belongs in that adapter's documentation, not here:
    // the CLI only knows that this one declared no way to be started (§22).
    throw cliError('CONFIG_INVALID', `the ${adapter.id} adapter cannot be started from a probe`, {
      details: { adapter: adapter.id, runtime: subject.runtimeId },
      hint: `it has no start command that leaves a server running behind it, so start ${adapter.id} yourself and probe again`,
    });
  }

  const host = answers.host ?? options.host ?? subject.host ?? '127.0.0.1';
  const port = answers.port ?? options.port ?? subject.port;
  context.err(`${context.theme.label('starting:')} ${subject.runtimeId} (${adapter.id})`);
  const started = await adapter.startServer({ host, port });

  return probeAdapter(adapter, {
    runtimeId: subject.runtimeId,
    url: started.url,
    apiKey: resolveProbeKey(context, subject, options, answers),
    logger: context.logger,
  });
};

/**
 * Ask, per subject, whether to probe it and with what (§22).
 *
 * The questions are the adapter's own; rendering them is the CLI's job alone.
 * Unlike stale-entry removal, a run that cannot ask has no useful fallback here
 * — probing the defaults is precisely what the user asked not to do — so this
 * fails rather than falling back.
 */
const ask = async (
  context: CliContext,
  subjects: readonly ProbeSubject[],
  options: ProbeCommandOptions,
): Promise<Map<string, ProbeAnswers>> => {
  if (!context.probePrompt) {
    throw cliError('CONFIG_INVALID', '--interactive needs a terminal to ask on', {
      hint: 'drop --interactive, or pass --url/--host/--port instead',
    });
  }

  const answers = new Map<string, ProbeAnswers>();
  for (const subject of subjects) {
    const answer = await context.probePrompt({
      adapterId: subject.adapter.id,
      runtimeId: subject.runtimeId,
      defaultUrl: defaultUrlOf(subject, options),
      questions: subject.adapter.probeQuestions,
      prefill: {
        ...(options.host !== undefined ? { host: options.host } : {}),
        ...(options.port !== undefined ? { port: options.port } : {}),
        ...(subject.host !== undefined ? { host: subject.host } : {}),
        ...(subject.port !== undefined ? { port: subject.port } : {}),
        ...(options.apiKeyEnv !== undefined ? { api_key_env: options.apiKeyEnv } : {}),
        ...(subject.apiKeyEnv !== undefined ? { api_key_env: subject.apiKeyEnv } : {}),
        ...(options.start === true ? { start: true } : {}),
      },
    });
    if (answer) answers.set(subject.runtimeId, answer);
  }
  return answers;
};

/** What this subject would be probed at with no further input. */
const defaultUrlOf = (subject: ProbeSubject, options: ProbeCommandOptions): string | null => {
  try {
    return resolveProbeUrl(subject.adapter, {
      url: options.url,
      host: options.host ?? subject.host,
      port: options.port ?? subject.port,
    });
  } catch {
    // A user-defined runtime has no conventional endpoint, so there is nothing
    // to offer — the questions are what produce one.
    return null;
  }
};

/**
 * What a probe covers (§22).
 *
 * Named: one declared runtime, or every declared runtime of one adapter, or —
 * when nothing is declared — the adapter itself. Bare: the declared runtimes,
 * plus any adapter with a conventional endpoint that no declared runtime covers,
 * so discovery still works before a configuration exists.
 */
const selectSubjects = (context: CliContext, target: string | undefined): ProbeSubject[] => {
  const declared = declaredRuntimes(context);

  if (target !== undefined) {
    // Naming a runtime exactly is the one thing that overrides `discovery: false`
    // — otherwise the flag would be a trap with no way to re-probe deliberately.
    const one = declared.find((subject) => subject.runtimeId === target);
    if (one) return [one];
    const byAdapter = declared.filter((subject) => subject.adapter.id === target);
    // "Every runtime of this adapter is excluded" is not "this adapter has no
    // runtimes". Falling through would reach the branch below and probe the
    // adapter's default target — an endpoint nobody declared.
    if (byAdapter.length > 0) return byAdapter.filter((subject) => subject.discoverable);
    if (context.adapters.has(target)) {
      return [
        {
          runtimeId: target,
          adapter: context.adapters.get(target),
          declared: false,
          discoverable: true,
        },
      ];
    }
    throw cliError('CONFIG_INVALID', `unknown runtime or adapter "${target}"`, {
      hint: `declared runtimes: ${declared.map((s) => s.runtimeId).join(', ') || '(none)'}; known adapters: ${context.adapters.ids().join(', ')}`,
    });
  }

  // Computed from *every* declared runtime, excluded ones included. Dropping an
  // excluded runtime here would leave its adapter "uncovered", and the fallback
  // below would probe it at `defaultProbeTarget` — resurrecting the very runtime
  // that was excluded, under the adapter's id and at an endpoint nobody declared.
  const covered = new Set(declared.map((subject) => subject.adapter.id));
  const undeclared = context.adapters
    .list()
    // An adapter without a conventional endpoint (custom) is only probed when
    // something names it: there is nothing worth guessing.
    .filter((adapter) => adapter.defaultProbeTarget !== null && !covered.has(adapter.id))
    .map((adapter) => ({ runtimeId: adapter.id, adapter, declared: false, discoverable: true }));

  return [...declared.filter((subject) => subject.discoverable), ...undeclared];
};

/**
 * The `runtimes:` section, when there is one.
 *
 * Discovery must work before configuration exists, and against a file that is
 * currently broken — that is what it is for — so a failure to load is an empty
 * list rather than an error.
 */
const declaredRuntimes = (context: CliContext): ProbeSubject[] => {
  if (!context.configLocation().found) return [];
  try {
    const config = context.loadConfig({ quiet: true });
    const subjects: ProbeSubject[] = [];
    for (const runtime of config.runtimes.values()) {
      if (!context.adapters.has(runtime.adapterId)) continue;
      subjects.push({
        runtimeId: runtime.id,
        adapter: context.adapters.get(runtime.adapterId),
        host: runtime.host,
        ...(runtime.port !== undefined ? { port: runtime.port } : {}),
        ...(runtime.auth?.apiKeyEnv !== undefined ? { apiKeyEnv: runtime.auth.apiKeyEnv } : {}),
        declared: true,
        discoverable: runtime.discovery,
      });
    }
    return subjects;
  } catch {
    return [];
  }
};

/**
 * Declared runtimes this run left out, for the one line that says so.
 *
 * Derived from what was actually selected rather than from the flag alone, so
 * naming a runtime explicitly — which probes it regardless — reports nothing,
 * and an adapter fan-out that skipped one still does.
 */
const excludedRuntimes = (context: CliContext, subjects: readonly ProbeSubject[]): string[] => {
  const selected = new Set(subjects.map((subject) => subject.runtimeId));
  return declaredRuntimes(context)
    .filter((subject) => !subject.discoverable && !selected.has(subject.runtimeId))
    .map((subject) => subject.runtimeId);
};

/**
 * Who already owns each configured model id (§22).
 *
 * The preview renders an id under its existing owner rather than under whichever
 * runtime was probed first, so what a bare probe prints matches both the current
 * configuration and what `--save` would write.
 *
 * A configuration too broken to load yields an empty map: the preview then falls
 * back to first-runtime-wins, which is no worse than before, and `--save` reads
 * ownership straight from the YAML anyway.
 */
const configuredOwners = (context: CliContext): ReadonlyMap<string, string> => {
  const owners = new Map<string, string>();
  if (!context.configLocation().found) return owners;
  try {
    for (const [id, instance] of context.loadConfig({ quiet: true }).models) {
      owners.set(id, instance.runtimeId);
    }
  } catch {
    return new Map();
  }
  return owners;
};

/**
 * A credential comes from `--api-key-env`, from an answer, or from the declared
 * runtime's own `auth` block. Never from the runtime's own settings files
 * (§10, §22).
 */
const resolveProbeKey = (
  context: CliContext,
  subject: ProbeSubject,
  options: ProbeCommandOptions,
  answers: ProbeAnswers,
): string | undefined => {
  const variable = answers.api_key_env ?? options.apiKeyEnv;
  if (variable) {
    const value = context.env[variable];
    if (!value) {
      throw cliError('DISCOVERY_AUTH_REQUIRED', `environment variable ${variable} is not set`, {
        details: { variable },
      });
    }
    return value;
  }
  // The credential is a property of the server, so it is addressable by runtime
  // key now rather than by matching host and port.
  if (subject.apiKeyEnv) return context.env[subject.apiKeyEnv];
  return undefined;
};

/**
 * A bare probe prints the configuration it found (§22): discovery exists to
 * *produce* configuration, so showing it is most of the point. Nothing is
 * written — this is the block to copy, or to commit with `--save`.
 */
const reportPreview = (
  context: CliContext,
  outcomes: readonly AdapterProbeOutcome[],
  subjects: readonly ProbeSubject[],
  existingOwners: ReadonlyMap<string, string>,
): void => {
  const preview = renderDiscoveredModels(outcomes, existingOwners);
  if (!preview) return;

  const only = subjects.length === 1 ? subjects[0]?.runtimeId : undefined;
  const saveCommand = only ? `lrd probe ${only} --save` : 'lrd probe <runtime> --save';
  context.out('');
  context.out(context.theme.muted('# configuration for the discovered models'));
  context.out(context.theme.muted(`# write it with: ${saveCommand}`));
  context.out(preview.yaml);

  for (const id of preview.collisions) {
    // Nothing owns these yet and several runtimes offered them, so the block
    // above had to pick one. A bare probe is read-only, so it says so rather
    // than failing — and it must not repeat the old advice to "probe one runtime
    // at a time", which does not resolve this and never did.
    context.err(
      `${context.theme.warn('warning:')} "${id}" is offered by more than one runtime and belongs to none yet, ` +
        'so the block above guessed — run `lrd probe --save` on a terminal to choose',
    );
  }
};

const save = async (
  context: CliContext,
  outcomes: readonly AdapterProbeOutcome[],
  options: ProbeCommandOptions,
): Promise<void> => {
  const location = context.configLocation();
  // Writing commands print the path before writing it (§12). This is the write
  // *target*, not the resolved path: when resolution finds nothing they differ,
  // and the home config is what actually gets written.
  const target = configWriteTarget(location);
  context.err(`${options.dryRun ? 'would write' : 'writing'}: ${context.theme.path(target)}`);
  if (!location.found) {
    context.err(
      context.theme.muted('(no configuration file was found, so a new one is created there)'),
    );
  }

  const plan = {
    outcomes,
    location,
    defaultServer: { host: '127.0.0.1', port: 8787 },
    logger: context.logger,
  } as const;

  /**
   * A first pass purely to learn which configured models the probe did not
   * find. This is not the user's `--dry-run` — it is how the question gets
   * asked before anything is written, and it is core that has to answer it:
   * ownership is read from raw `runtime:` keys, and `loadConfig` rejects a file
   * containing an entry without one, so the CLI cannot read what core can.
   * A name conflict throws here, before anybody is asked anything.
   */
  const before = readTextIfExists(target);
  const planned = saveDiscovery({ ...plan, dryRun: true });
  const remove = await decideRemovals(context, planned.stale, options);
  const assign = await decideAssignments(context, planned.ambiguous, options);

  if (remove.length > 0 && readTextIfExists(target) !== before) {
    // A prompt can sit open for minutes, and the answer to it is a list of ids
    // to delete from the file as it looked when the question was asked. If the
    // file moved underneath, that answer is about something else now.
    throw cliError(
      'CONFIG_INVALID',
      `${target} changed while the question was open; nothing was written`,
      { details: { path: target }, hint: 're-run the probe against the current file' },
    );
  }

  const result = saveDiscovery({ ...plan, dryRun: options.dryRun === true, remove, assign });

  if (context.options.json) {
    context.json({
      path: result.path,
      written: result.written,
      backup: result.backup,
      added: result.added,
      updated: result.updated,
      stale: result.stale,
      removed: result.removed,
      unowned: result.unowned,
      retained: result.retained,
      ambiguous: result.ambiguous,
      skipped: outcomes.flatMap((outcome) => outcome.skipped),
    });
    return;
  }

  reportSkipped(context, outcomes);
  for (const entry of result.unowned) {
    // Replacement works off `runtime:`, so an entry without a usable one is
    // owned by nobody: it survives every save and makes `loadConfig` reject the
    // file.
    context.err(
      `${context.theme.warn('warning:')} models.${entry.id} ${entry.reason}, so it was left as-is — ` +
        'it cannot be replaced and will fail to load; point it at a declared runtime or delete it',
    );
  }

  if (result.retained.length > 0) {
    // Not a conflict and not a change: these already have an owner, so the probe
    // rediscovering them from a sibling runtime says nothing new (§22).
    for (const entry of result.retained) {
      context.out(
        `${context.theme.muted('left on')} ${context.theme.id(entry.runtime)}${context.theme.muted(':')} ${entry.id}`,
      );
    }
  }
  for (const entry of result.ambiguous) {
    context.err(
      `${context.theme.warn('warning:')} "${entry.id}" was not written: ${entry.candidates.join(
        ' and ',
      )} both serve ${entry.adapter} and nothing says which should own it — ` +
        'run `lrd probe --save` on a terminal to choose, or add the entry by hand',
    );
  }

  const kept = result.stale.filter((entry) => !result.removed.includes(entry.id));
  if (kept.length > 0) {
    // Configured, and this probe did not find it. That is the idle-backend case
    // far more often than it is a deletion, so saying so beats acting on it.
    context.out(
      `${context.theme.warn('kept, not found by this probe:')} ${kept.map((entry) => entry.id).join(', ')}`,
    );
  }

  if (result.written) {
    if (result.backup) context.out(context.theme.muted(`backup: ${result.backup}`));
    const added = result.added.models.length;
    context.out(
      `${context.theme.ok(`wrote ${added} new entr${added === 1 ? 'y' : 'ies'} to`)} ${context.theme.path(result.path)}`,
    );
    if (result.added.runtimes.length > 0) {
      context.out(`declared runtimes: ${result.added.runtimes.join(', ')}`);
    }
    if (result.updated.models.length > 0) {
      // Refreshed, not rewritten: whatever else was configured on them stands.
      // Only models are named: this line is about hand-tuning that survived, and
      // a refreshed runtime block has none to lose.
      context.out(`refreshed, options kept: ${result.updated.models.join(', ')}`);
    }
    if (result.removed.length > 0) {
      context.out(`${context.theme.danger('removed:')} ${result.removed.join(', ')}`);
    }
  } else {
    context.out(context.theme.muted(`--- ${result.path} (dry run, nothing written) ---`));
    context.out(result.content.trimEnd());
  }
};

/**
 * Which stale entries this run may delete (§22).
 *
 * Deleting a configured model is the one destructive thing `--save` does, so
 * nothing is inferred: `--force` says yes to all of them, a terminal is asked,
 * and a run that cannot ask keeps them and says so. That last case is why this
 * differs from `lrd apply`, which fails when it cannot ask — here, not asking
 * still leaves a correct configuration, just a larger one, and `probe --save`
 * stays usable from a script.
 */
const decideRemovals = async (
  context: CliContext,
  stale: readonly StaleEntry[],
  options: ProbeCommandOptions,
): Promise<readonly string[]> => {
  if (stale.length === 0) return [];
  const ids = stale.map((entry) => entry.id);

  if (options.force === true) return ids;

  // Both of these leave the entries in place; the summary below names them, so
  // these say only *why* nothing was asked.
  if (options.dryRun === true) {
    context.err(
      context.theme.muted('a dry run removes nothing, so nothing was asked — --force removes them'),
    );
    return [];
  }
  if (!context.removalPrompt) {
    context.err(
      context.theme.muted(
        'no terminal to ask on, so nothing was removed — pass --force to remove them',
      ),
    );
    return [];
  }

  return context.removalPrompt({ stale });
};

/**
 * Which runtime owns a model several of one adapter's runtimes offered (§22).
 *
 * The mirror of `decideRemovals`, and it fails the same way: a run that cannot
 * ask writes nothing for these and says so, rather than guessing. Guessing is
 * what the old first-runtime-wins preview did, and it is how a model ends up
 * served by the wrong server.
 */
const decideAssignments = async (
  context: CliContext,
  ambiguous: readonly AmbiguousEntry[],
  options: ProbeCommandOptions,
): Promise<Readonly<Record<string, string>>> => {
  if (ambiguous.length === 0) return {};

  // Both of these leave the ids unwritten; the warnings above name them, so
  // these say only *why* nothing was asked.
  if (options.dryRun === true) {
    context.err(
      context.theme.muted('a dry run writes nothing, so nothing was asked about ownership'),
    );
    return {};
  }
  if (!context.assignmentPrompt) {
    context.err(
      context.theme.muted('no terminal to ask on, so ambiguous models were left unconfigured'),
    );
    return {};
  }

  return context.assignmentPrompt({ ambiguous });
};

const report = (context: CliContext, outcomes: readonly AdapterProbeOutcome[]): void => {
  const theme = context.theme;
  const width = Math.max(...outcomes.map((outcome) => outcome.runtimeId.length), 8);
  for (const outcome of outcomes) {
    const { adapter, runtimeId, result } = outcome;
    // Padded first, styled second: the escape bytes are not printable width.
    const label = theme.heading(runtimeId.padEnd(width));
    const indent = ' '.repeat(width);
    const listModels = (models: readonly { id: string; contextLength?: number }[]): void => {
      for (const model of models) {
        const limit = model.contextLength ? theme.muted(` (context ${model.contextLength})`) : '';
        context.out(`${indent}    ${theme.id(model.id)}${limit}`);
      }
    };

    if (result.status === 'not_installed') {
      // Nothing is down: nothing is installed. An adapter that cannot start or
      // drive anything has no endpoint worth recording (§22).
      context.out(`${label}  ${theme.url(result.url)}  ${theme.muted('not installed')}`);
      context.out(theme.muted(`${indent}  ${result.detail}`));
      continue;
    }

    if (result.status === 'foreign_server') {
      context.out(`${label}  ${theme.url(result.url)}  ${theme.warn('not this runtime')}`);
      context.out(theme.muted(`${indent}  ${result.detail}`));
      continue;
    }

    if (result.status === 'auth_required') {
      context.out(
        `${label}  ${theme.url(result.url)}  ${theme.warn('running, credential required')}`,
      );
      context.out(theme.muted(`${indent}  supply one with --api-key-env <VAR>`));
      continue;
    }

    // Models installed locally but not loaded. For a single-model runtime the
    // server is usually down, so this is the answer that matters.
    const available = result.available ?? [];
    const installed = available.length > 0 ? `, ${available.length} installed` : '';

    if (result.status === 'not_running') {
      // "Not running" is an answer, not an error (§22).
      context.out(`${label}  ${theme.url(result.url)}  ${theme.muted(`not running${installed}`)}`);
      if (result.detail) context.out(theme.muted(`${indent}  ${result.detail}`));
      listModels(available);
      continue;
    }

    const count = result.models.length;
    context.out(
      `${label}  ${theme.url(result.url)}  ${theme.ok(`running, serving ${count} model${count === 1 ? '' : 's'}${installed}`)} ${theme.muted(`(${adapter})`)}`,
    );
    listModels(result.models);
    for (const model of available) {
      if (result.models.some((served) => served.id === model.id)) continue;
      context.out(`${indent}    ${theme.id(model.id)}${theme.muted(' (installed, not loaded)')}`);
    }
  }
  reportSkipped(context, outcomes);
};

const reportSkipped = (context: CliContext, outcomes: readonly AdapterProbeOutcome[]): void => {
  // Deduplicated by adapter and id, not merely by line: two runtimes of one
  // adapter read the same installed catalogue, so every skip in it would
  // otherwise be reported once per runtime.
  const seen = new Set<string>();
  for (const outcome of outcomes) {
    for (const skipped of outcome.skipped) {
      const key = `${outcome.adapter}\u0000${skipped.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Skipped, never sanitized: a rewritten id no longer matches what the
      // runtime serves and would fail identity verification confusingly (§22).
      context.err(
        `${context.theme.warn('skipped')} ${outcome.adapter} model id ${JSON.stringify(skipped.id)}: ${skipped.reason}`,
      );
    }
  }
};
