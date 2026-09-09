import { checkbox, confirm, input, number, select } from '@inquirer/prompts';
import type { ProbeAnswers, ProbeQuestion } from '@llm-runtime-dock/core';

/**
 * Every place the CLI asks a question: role selection for `lrd apply` (spec §23,
 * §27), stale-entry removal for `lrd probe --save`, and the two prompts of
 * `lrd probe --interactive` (§22).
 *
 * This is the only file in the repository that imports a terminal prompt. An
 * adapter *declares* its probe questions as data (`probeQuestions`) and never
 * learns how they are asked, for the same reason `packages/core` stays free of
 * terminal concerns.
 *
 * When an agent needs a role mapping and the configuration has none, asking is
 * friendlier than failing — the answer is a choice between the model ids the
 * configuration already declares, which is a short list the user wrote.
 *
 * Both prompts are injectable so that tests, `--json` runs and pipelines never
 * reach a real terminal. Nothing here knows an agent's file format or a
 * runtime's; they only know ids.
 */

export interface RoleQuestion {
  readonly agentDisplayName: string;
  readonly role: string;
  /** Logical model ids from `models:`, in configuration order. */
  readonly choices: readonly string[];
}

/** Answers a role question, or `null` to leave that role unset. */
export type RolePrompt = (question: RoleQuestion) => Promise<string | null>;

/** The sentinel the "leave unset" choice carries. Never a valid model id. */
const SKIP = '\u0000skip';

export const interactiveRolePrompt: RolePrompt = async (question) => {
  const answer = await select<string>({
    message: `${question.agentDisplayName}: which model should "${question.role}" use?`,
    choices: [
      ...question.choices.map((id) => ({ name: id, value: id })),
      { name: '— leave unset —', value: SKIP, description: 'do not write this role' },
    ],
  });
  return answer === SKIP ? null : answer;
};

/**
 * Prompting needs a real terminal on both ends, and must never fire when the
 * caller asked for machine-readable output.
 */
export const canPrompt = (json: boolean | undefined): boolean =>
  json !== true && process.stdin.isTTY === true && process.stdout.isTTY === true;

export interface RemovalQuestion {
  /**
   * Configured entries the probed adapters did not report. A bare `lrd probe`
   * covers several adapters at once, so each entry carries its own.
   */
  readonly stale: readonly { id: string; adapter: string; runtime: string }[];
}

/** Answers which stale entries may be deleted. Ids not returned are kept. */
export type RemovalPrompt = (question: RemovalQuestion) => Promise<readonly string[]>;

/**
 * Ask before deleting a configured model the probe did not find (§22).
 *
 * Nothing is pre-checked and the list is not required, so pressing enter keeps
 * everything: a wrong "yes" here is only recoverable from the backup, while a
 * wrong "no" costs one more probe. The idle-backend case — a model that is
 * configured and perfectly good, whose runtime simply is not running right now
 * — is the common one, and it must not need a rescue.
 */
export const interactiveRemovalPrompt: RemovalPrompt = async (question) =>
  checkbox<string>({
    message:
      'These models are configured but the probe did not find them. Select any to remove (enter keeps all):',
    required: false,
    choices: question.stale.map((entry) => ({
      name: `models.${entry.id} (runtime ${entry.runtime}, ${entry.adapter})`,
      value: entry.id,
      checked: false,
    })),
  });

export interface AssignmentQuestion {
  /**
   * Models nothing owns yet that several runtimes of one adapter all offered
   * (§22). A catalogue-based adapter lists the same catalogue from every one of
   * its servers, so the probe cannot say which of them should serve a model.
   */
  readonly ambiguous: readonly { id: string; adapter: string; candidates: readonly string[] }[];
}

/**
 * Answers which runtime owns each ambiguous id. Ids left out are not written,
 * so declining costs one more probe rather than a wrong assignment.
 */
export type AssignmentPrompt = (
  question: AssignmentQuestion,
) => Promise<Readonly<Record<string, string>>>;

/**
 * Ask which runtime should serve a model several of them offer (§22).
 *
 * Only ever asked within one adapter, where the runtimes are interchangeable
 * servers of the same installation and the answer is a matter of intent — which
 * is exactly what `keep_resident` creates: a second MTPLX runtime whose whole
 * purpose is to hold one model. Across adapters the same id means two different
 * sets of weights, and that fails rather than being asked about.
 *
 * A skip option is offered per model rather than assumed, because leaving an id
 * unconfigured is a real answer here and the alternative is guessing.
 */
export const interactiveAssignmentPrompt: AssignmentPrompt = async (question) => {
  const answers: Record<string, string> = {};
  for (const entry of question.ambiguous) {
    const choice = await select<string>({
      message: `Which runtime should serve "${entry.id}"? (offered by ${entry.candidates.length} ${entry.adapter} runtimes)`,
      choices: [
        ...entry.candidates.map((runtimeId) => ({ name: runtimeId, value: runtimeId })),
        { name: "skip — don't configure it", value: '' },
      ],
    });
    if (choice !== '') answers[entry.id] = choice;
  }
  return answers;
};

/** One probe subject an interactive run offers to probe (§22). */
export interface ProbeQuestionRequest {
  readonly adapterId: string;
  readonly runtimeId: string;
  /**
   * Where this subject would be probed if the user answers nothing. Shown only
   * when the adapter asks no questions of its own; otherwise the host and port
   * defaults carry the same information, in the place where it can be changed.
   */
  readonly defaultUrl: string | null;
  readonly questions: readonly ProbeQuestion[];
  /** Pre-fill from explicit flags. An answer still wins over a flag. */
  readonly prefill: ProbeAnswers;
}

/** Answers for one subject, or `null` to skip it entirely. */
export type ProbePrompt = (request: ProbeQuestionRequest) => Promise<ProbeAnswers | null>;

export interface ProbeSaveRequest {
  readonly path: string;
  /** The configuration the save would write, so the answer is an informed one. */
  readonly preview: string;
}

export type ProbeSavePrompt = (request: ProbeSaveRequest) => Promise<boolean>;

/**
 * Ask an adapter's own questions (§22).
 *
 * The adapter declared them; this renders them. `default` comes from the
 * adapter unless a flag pre-filled the same key, so `--port 8001 --interactive`
 * offers 8001 and still lets the answer override it. An empty string answer
 * means "leave it", not "set it to empty".
 */
/**
 * The "probe this one?" question (§22).
 *
 * It asks about the *runtime*, not about an endpoint. Naming the address here
 * would read as "probe it there, yes or no?", so somebody who wanted a different
 * port answers no and never reaches the question that would have let them say
 * so — the address is what the adapter's own questions are for.
 *
 * The adapter is named only when it is not already the runtime's own name, which
 * for a first probe it usually is. The endpoint appears only when the adapter
 * asks nothing at all, since that is the one case where it has nowhere else to
 * go.
 *
 * Exported so the wording is pinned by a test: the inquirer call around it
 * needs a terminal, and this is the part that was wrong.
 */
export const probePromptMessage = (request: ProbeQuestionRequest): string => {
  const which =
    request.runtimeId === request.adapterId
      ? request.runtimeId
      : `${request.runtimeId} (${request.adapterId})`;
  const where =
    request.questions.length === 0 && request.defaultUrl ? ` at ${request.defaultUrl}` : '';
  return `probe ${which}${where}?`;
};

export const interactiveProbePrompt: ProbePrompt = async (request) => {
  const wanted = await confirm({ message: probePromptMessage(request), default: true });
  if (!wanted) return null;

  const answers: {
    host?: string;
    port?: number;
    api_key_env?: string;
    start?: boolean;
  } = {};

  for (const question of request.questions) {
    if (question.key === 'port') {
      const fallback = request.prefill.port ?? numberDefault(question.default);
      const value = await number({ message: question.label, default: fallback });
      if (value !== undefined) answers.port = value;
      continue;
    }
    if (question.key === 'start') {
      const value = await confirm({
        message: question.label,
        default: request.prefill.start ?? question.default === true,
      });
      answers.start = value;
      continue;
    }
    const fallback =
      question.key === 'host'
        ? (request.prefill.host ?? stringDefault(question.default))
        : (request.prefill.api_key_env ?? stringDefault(question.default));
    const value = (await input({ message: question.label, default: fallback })).trim();
    if (value === '') continue;
    if (question.key === 'host') answers.host = value;
    else answers.api_key_env = value;
  }

  return answers;
};

const stringDefault = (value: string | number | boolean | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

const numberDefault = (value: string | number | boolean | undefined): number | undefined =>
  typeof value === 'number' ? value : undefined;

/**
 * Offer to write what the probe found (§22).
 *
 * The preview is shown first: `--save` backs the file up but still overwrites
 * it, so the answer should be about something the user has actually seen.
 */
export const interactiveProbeSavePrompt: ProbeSavePrompt = async (request) => {
  return confirm({ message: `write this configuration to ${request.path}?`, default: false });
};
