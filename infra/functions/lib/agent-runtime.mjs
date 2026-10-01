/**
 * A small, auditable agent loop on the Amazon Bedrock Converse API (tool use).
 *
 * An agent = a role-specific system prompt + a set of tools (JSON-schema'd functions) + a model
 * chain. The MODEL decides which tools to call and when it has enough to answer; the runtime only
 * executes tools, enforces limits (turns, deadline, output size) and records what happened.
 *
 *   user input ──► model ──tool_use──► run tools ──toolResult──► model ──end_turn──► answer
 *
 * Every run is recorded (agent, trigger, model, turns, tool calls, tokens, outcome) so the public
 * Agent Console can show that the agents really are working, and what they decided.
 */
import { parseJsonLoose } from './util.mjs';

const MAX_TOOL_RESULT_CHARS = 12_000;

export class AgentError extends Error {
  constructor(message, { code = 'agent_error', cause } = {}) {
    super(message, { cause });
    this.name = 'AgentError';
    this.code = code;
  }
}

/**
 * Earlier turns as Converse messages: text only, starting with the user and alternating (Converse
 * rejects anything else), so a client cannot smuggle tool results or a system turn into it.
 */
export function conversation(history = []) {
  const out = [];
  for (const h of Array.isArray(history) ? history : []) {
    const role = h?.role === 'assistant' ? 'assistant' : h?.role === 'user' ? 'user' : null;
    const text = typeof h?.text === 'string' ? h.text.trim() : '';
    if (!role || !text) continue;
    if (!out.length && role !== 'user') continue;
    if (out.length && out.at(-1).role === role) out.at(-1).content[0].text += `\n${text}`;
    else out.push({ role, content: [{ text }] });
  }
  if (out.length && out.at(-1).role === 'user') out.pop(); // the new question follows
  return out;
}

const toolSpec = (t) => ({
  toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema } },
});

/** Converse tool results must be JSON objects; arrays/primitives are wrapped. Oversized results are truncated. */
function asToolJson(value) {
  const obj = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : { result: value };
  const text = JSON.stringify(obj);
  if (text.length <= MAX_TOOL_RESULT_CHARS) return obj;
  return { truncated: true, preview: text.slice(0, MAX_TOOL_RESULT_CHARS) };
}

/** Pull the first JSON object out of model text (tolerates ```json fences and prose around it). */
export function extractJson(text) {
  if (typeof text !== 'string') throw new AgentError('Model returned no text', { code: 'no_text' });
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new AgentError('Model output contained no JSON object', { code: 'no_json' });
  try {
    return parseJsonLoose(text.slice(start, end + 1));
  } catch (err) {
    throw new AgentError(`Model output was not valid JSON: ${err.message}`, { code: 'bad_json' });
  }
}

/**
 * Run one agent to completion.
 *
 * @param {object} p
 * @param {object} p.agent       { name, system, tools?: [{name, description, inputSchema, handler}], models: string[],
 *                                 maxTurns?, maxTokens?, temperature? }
 * @param {string} p.input       the task, as text
 * @param {Function} p.converse  (params, opts) => Bedrock Converse response
 * @param {number} [p.deadline]  epoch ms; the run is abandoned after this
 * @param {Function} [p.validate] (text) => value; throws if the answer is unusable. On failure the
 *                                model gets `repairs` extra turns to correct itself (seeing the error),
 *                                e.g. when it emits malformed JSON — observed live on 2026-09-29.
 * @param {Function} [p.repairMessage] (error) => text sent back after a failed validation
 * @param {Array} [p.history]     earlier turns of a conversation, [{ role: 'user'|'assistant', text }]
 * @returns {{ text, value, model, turns, toolCalls, usage, stopReason, repaired }}
 */
export async function runAgent({ agent, input, converse, deadline = Date.now() + 20_000, now = Date.now, validate = null, repairs = 1, repairMessage = null, history = [] }) {
  const tools = agent.tools ?? [];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const maxTurns = (agent.maxTurns ?? 6) + (validate ? repairs : 0);
  const usage = { inputTokens: 0, outputTokens: 0 };
  const toolCalls = [];
  let lastError;

  // Model chain: fall back to the next model only if the FIRST call fails (switching models mid
  // conversation would mix tool-use ids between providers).
  for (const modelId of agent.models.filter(Boolean)) {
    const messages = [...conversation(history), { role: 'user', content: [{ text: input }] }];
    let repairsLeft = validate ? repairs : 0;
    let repaired = 0;
    try {
      for (let turn = 1; turn <= maxTurns; turn += 1) {
        const remaining = deadline - now();
        if (remaining < 1500) throw new AgentError('Agent ran out of time', { code: 'deadline' });
        const res = await converse(
          {
            modelId,
            system: [{ text: agent.system }],
            messages,
            ...(tools.length ? { toolConfig: { tools: tools.map(toolSpec) } } : {}),
            inferenceConfig: { maxTokens: agent.maxTokens ?? 1200, temperature: agent.temperature ?? 0 },
          },
          { abortSignal: AbortSignal.timeout(remaining) },
        );
        usage.inputTokens += res.usage?.inputTokens ?? 0;
        usage.outputTokens += res.usage?.outputTokens ?? 0;
        const message = res.output?.message;
        if (!message) throw new AgentError('Empty model response', { code: 'empty' });
        // Reasoning blocks are the model's own scratch work; they are not sent back.
        messages.push({ ...message, content: (message.content ?? []).filter((c) => !c.reasoningContent) });

        if (res.stopReason === 'tool_use') {
          // Tool calls asked for in the same turn run together (every HeatShield tool is a read);
          // results go back in the order they were asked for.
          const results = await Promise.all((message.content ?? []).filter((b) => b.toolUse).map(async (block) => {
            const { toolUseId, name, input: args } = block.toolUse;
            const tool = byName.get(name);
            const started = now();
            let status = 'success';
            let content;
            try {
              if (!tool) throw new Error(`Unknown tool "${name}"`);
              // Treat model-generated arguments as untrusted input; handlers validate their own args.
              content = asToolJson(await tool.handler(args ?? {}));
            } catch (err) {
              status = 'error';
              content = { error: err.message };
            }
            toolCalls.push({ name, ok: status === 'success', ms: now() - started });
            return { toolResult: { toolUseId, content: [{ json: content }], status } };
          }));
          messages.push({ role: 'user', content: results });
          continue;
        }

        if (res.stopReason === 'max_tokens') throw new AgentError('Agent output was truncated', { code: 'truncated' });
        const text = (message.content ?? []).map((c) => c.text ?? '').join('').trim();
        if (!validate) return { text, model: modelId, turns: turn, toolCalls, usage, stopReason: res.stopReason, repaired };
        try {
          const value = validate(text);
          return { text, value, model: modelId, turns: turn, toolCalls, usage, stopReason: res.stopReason, repaired };
        } catch (err) {
          if (repairsLeft <= 0) throw new AgentError(`Output failed validation: ${err.message}`, { code: 'invalid_output', cause: err });
          repairsLeft -= 1;
          repaired += 1;
          messages.push({ role: 'user', content: [{ text: repairMessage ? repairMessage(err) : `Your reply could not be used: ${err.message}. Reply again with ONLY the corrected JSON object and nothing else.` }] });
        }
      }
      throw new AgentError(`Agent did not finish within ${maxTurns} turns`, { code: 'max_turns' });
    } catch (err) {
      lastError = err;
      const firstCallFailed = toolCalls.length === 0 && !(err instanceof AgentError && err.code === 'deadline');
      if (!firstCallFailed) break; // mid-run failure: do not restart on another model
    }
  }
  const error = lastError ?? new AgentError('No model available', { code: 'no_model' });
  // What a failed run consumed, so a caller that recovers can still record it.
  if (error && typeof error === 'object') Object.assign(error, { usage, toolCalls });
  throw error;
}
