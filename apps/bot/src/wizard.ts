/**
 * Moteur de parcours conversationnels. L'état (pile d'identifiants d'étapes + données) est sérialisable :
 * une conversation reprend après un redémarrage du bot. Les étapes sont des définitions sans état,
 * retrouvées par identifiant dans le registre du parcours.
 */
import type { ApiClient } from './api-client.ts';
import type { FileRef } from './files.ts';
import type { Data, Session } from './session.ts';
import type { Keyboard } from './telegram/types.ts';

export type Input =
  | { kind: 'text'; text: string }
  | { kind: 'callback'; data: string }
  | { kind: 'file'; file: FileRef };

export interface Prompt {
  text: string;
  keyboard: Keyboard;
}

export interface StepEnv {
  api: ApiClient;
  uid: number;
  languages: { code: string; name: string }[];
  maxFileBytes: number;
}

export interface StepCtx {
  data: Data;
  tmp: Data;
  env: StepEnv;
}

export type StepResult = { status: 'done'; value?: unknown } | { status: 'invalid'; error: string } | { status: 'stay' };

export interface StepDef {
  id: string;
  /** Étape ignorée si la condition est fausse. */
  when?: (d: Data) => boolean;
  /** Préparation asynchrone avant la question (ex. appel à l'API). */
  prepare?: (ctx: StepCtx) => Promise<void>;
  ask: (ctx: StepCtx) => Prompt;
  handle: (input: Input, ctx: StepCtx) => StepResult | Promise<StepResult>;
  apply: (d: Data, value: any) => void;
  /** Étapes à exécuter juste après celle-ci (boucles, branches). */
  next?: (value: any, d: Data) => string[];
}

export interface Flow {
  id: string;
  init: (args: Data) => Data;
  start: string[];
  steps: Record<string, StepDef>;
}

export type Outcome = { kind: 'prompt'; prompt: Prompt; edit: boolean } | { kind: 'done' };

export class WizardEngine {
  private readonly flows = new Map<string, Flow>();

  constructor(flows: Flow[]) {
    for (const f of flows) this.flows.set(f.id, f);
  }

  flow(id: string): Flow {
    const f = this.flows.get(id);
    if (!f) throw new Error(`Parcours inconnu : ${id}`);
    return f;
  }

  async begin(session: Session, flowId: string, args: Data, env: StepEnv): Promise<Outcome> {
    const f = this.flow(flowId);
    session.flow = flowId;
    session.phase = 'wizard';
    session.data = f.init(args);
    session.stack = [...f.start];
    session.tmp = {};
    session.progress = {};
    session.error = null;
    return this.advance(session, env, false);
  }

  /** Redemande l'étape courante (après un redémarrage, ou pour réafficher la question). */
  async current(session: Session, env: StepEnv): Promise<Outcome> {
    return this.advance(session, env, false);
  }

  private async advance(session: Session, env: StepEnv, edit: boolean): Promise<Outcome> {
    const f = this.flow(session.flow as string);
    while (session.stack.length > 0) {
      const step = f.steps[session.stack[0] as string];
      if (!step) throw new Error(`Étape inconnue : ${session.stack[0]}`);
      if (step.when && !step.when(session.data)) {
        session.stack.shift();
        continue;
      }
      const ctx: StepCtx = { data: session.data, tmp: session.tmp, env };
      if (step.prepare) await step.prepare(ctx);
      return { kind: 'prompt', prompt: step.ask(ctx), edit };
    }
    return { kind: 'done' };
  }

  async handle(session: Session, input: Input, env: StepEnv): Promise<Outcome> {
    const f = this.flow(session.flow as string);
    const step = f.steps[session.stack[0] as string];
    if (!step) throw new Error('Aucune étape en cours');
    const ctx: StepCtx = { data: session.data, tmp: session.tmp, env };
    const r = await step.handle(input, ctx);
    if (r.status === 'invalid') {
      const p = step.ask(ctx);
      return { kind: 'prompt', prompt: { text: `⚠️ ${r.error}\n\n${p.text}`, keyboard: p.keyboard }, edit: false };
    }
    if (r.status === 'stay') return { kind: 'prompt', prompt: step.ask(ctx), edit: true };
    step.apply(session.data, r.value);
    session.stack.shift();
    session.stack.unshift(...(step.next?.(r.value, session.data) ?? []));
    session.tmp = {};
    return this.advance(session, env, false);
  }
}
