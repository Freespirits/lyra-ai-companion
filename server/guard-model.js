/* Model-based content guard. Lives entirely in Lyra (the OpenClaw agent is never
   modified): classify a completed reply with a small safety model via Ollama so
   we catch explicit content a keyword list can't. Allows flirtation/romance,
   blocks graphic sexual content + sexual aggression/coercion + violence/harm.

   Enabled when GUARD_MODEL is set (e.g. llama-guard3:1b) and LYRA_GUARD != off.
   Fail-closed: on any classifier error the caller should treat the reply as
   blocked so explicit content never leaks past a broken guard. */

export function guardModelName(env = process.env) {
  if (String((env && env.LYRA_GUARD) || 'on').toLowerCase() === 'off') return '';
  return String((env && env.GUARD_MODEL) || '').trim();
}

const SYSTEM = 'You are a strict content-safety classifier for an adult companion app. '
  + 'Flirtation, romance, affection and suggestive banter are ALLOWED. '
  + 'BLOCK: sexually explicit content (graphic sexual acts or descriptions), any sexual aggression, '
  + 'coercion or non-consent, and any violence or harm. '
  + 'Respond with exactly one word: SAFE or UNSAFE.';

/* Returns { checked, blocked, raw }. Throws on network/model error (caller
   fail-closes). opts.fetch is injectable for tests; opts.signal to abort. */
export async function moderateWithModel(userText, replyText, opts = {}) {
  const env = opts.env || process.env;
  const model = guardModelName(env);
  if (!model) return { checked: false, blocked: false, raw: '' };

  const doFetch = opts.fetch || fetch;
  const url = (env.OLLAMA_URL || 'http://localhost:11434') + '/api/chat';
  const body = {
    model, stream: false,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'Classify this companion reply:\n"""\n' + String(replyText || '').slice(0, 6000) + '\n"""' },
    ],
    options: { temperature: 0, num_predict: 12 },
  };
  const r = await doFetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: opts.signal,
  });
  if (!r.ok) throw new Error('guard model ' + r.status);
  const j = await r.json();
  const out = String((j.message && j.message.content) || '').toLowerCase();
  return { checked: true, blocked: /\bunsafe\b/.test(out), raw: out.slice(0, 80) };
}
