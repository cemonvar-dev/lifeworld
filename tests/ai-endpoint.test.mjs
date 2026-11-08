// Runs api/ai.js with Supabase and OpenAI mocked. No network calls.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.OPENAI_API_KEY = 'x'; process.env.SUPABASE_URL = 'https://mock.test';
process.env.SUPABASE_ANON_KEY = 'x'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'x';
const tmp = join(tmpdir(), `fiblia-ai-${process.pid}.mjs`);
writeFileSync(tmp, readFileSync(new URL('../api/ai.js', import.meta.url)));
const { default: handler } = await import(pathToFileURL(tmp).href);
const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b });
let user, openaiStatus, calls, openaiMessage = { content: 'hi' };
globalThis.fetch = async (url, opts) => {
  calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
  if (url.includes('/auth/v1/user')) return json(user);
  if (url.includes('consume_ai_quota')) return json([{ allowed: true, used: 1, day_limit: 25 }]);
  if (url.includes('ai_memory')) return json([]);
  if (url.includes('openai.com')) return openaiStatus === 200 ? json({ choices: [{ message: openaiMessage }] }) : json({ error: { message: 'secret upstream detail' } }, openaiStatus);
  throw new Error('unexpected ' + url);
};
async function call(body, u = { id: 'u1' }, status = 200) {
  user = u; openaiStatus = status; calls = [];
  const res = { code: 0, out: null, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { this.out = o; return this; }, end() { return this; } };
  const orig = console.error; console.error = () => {};
  await handler({ method: 'POST', headers: { authorization: 'Bearer t' }, body }, res);
  console.error = orig;
  return { res, rpc: calls.some(c => c.url.includes('consume_ai_quota')), ai: calls.find(c => c.url.includes('openai.com') && c.body.max_tokens === 1500) };
}
const hello = [{ role: 'user', content: 'hello' }];
let r;
r = await call({ messages: hello }, { id: 'u', user_metadata: { premium: true } });
assert(r.rpc, 'user_metadata premium must not bypass quota'); console.log('ok user_metadata premium still consumes quota');
r = await call({ messages: hello }, { id: 'u', app_metadata: { premium: true } });
assert(!r.rpc && r.res.code === 200, 'app_metadata premium bypasses'); console.log('ok app_metadata premium bypasses quota');
r = await call({ messages: [{ role: 'system', content: 'evil' }, ...hello] });
assert.deepStrictEqual(r.ai.body.messages.filter(m => m.role === 'system').length, 1); assert(!JSON.stringify(r.ai.body.messages).includes('evil')); console.log('ok caller system message dropped');
r = await call({ messages: Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: 'x'.repeat(9000) + i })), taskContext: 'y'.repeat(99999) });
assert.strictEqual(r.ai.body.messages.length, 21); assert.strictEqual(r.ai.body.messages[1].content.length, 8000); assert(r.ai.body.messages[0].content.length < 34000); console.log('ok history, message and context capped');
r = await call({ messages: 'nope' });
assert(r.res.code === 400 && !r.rpc); console.log('ok bad body rejected before quota');
r = await call({ messages: [{ role: 'system', content: 'only' }] });
assert(r.res.code === 400 && !r.rpc); console.log('ok no usable turns rejected before quota');
r = await call({ messages: [{ role: 'user', content: 'z'.repeat(40001) }], responseFormat: { type: 'json_object' } });
assert(r.res.code === 400 && !r.rpc); console.log('ok oversized JSON prompt rejected');
r = await call({ messages: [{ role: 'user', content: 'z'.repeat(20000) }], responseFormat: { type: 'json_object' } });
assert(r.res.code === 200 && r.ai.body.response_format.type === 'json_object' && r.ai.body.messages[1].content.length === 20000); console.log('ok reschedule-size JSON prompt passes intact');
r = await call({ messages: hello }, { id: 'u' }, 429);
assert(r.res.code === 502 && r.res.out.code === 'ai_unavailable' && !JSON.stringify(r.res.out).includes('secret')); console.log('ok OpenAI 429 becomes 502 without upstream text');
r = await call({ messages: hello });
assert(r.res.code === 200 && r.res.out.reply === 'hi'); console.log('ok normal chat works');

// Task changes arrive through a validated tool call.
const toolReply = args => ({ content: null, tool_calls: [{ function: { name: 'propose_task_changes', arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] });
r = await call({ messages: hello });
assert.strictEqual(r.ai.body.tools[0].function.name, 'propose_task_changes'); console.log('ok chat offers the task tool');
r = await call({ messages: hello, responseFormat: { type: 'json_object' } });
assert.strictEqual(r.ai.body.tools, undefined); console.log('ok reschedule JSON mode has no tools');
openaiMessage = toolReply({ message: 'Here you go', actions: [
  { type: 'create', name: '  Walk  ', frequency: 'daily', evil: 'x' },
  { type: 'create' },
  { type: 'update', id: 't1', frequency: 'hourly', status: 'hacked', weekdays: [1, 1, 9, 'x'], end_date: 'soon', day_of_month: 40 },
  { type: 'delete', id: 't2', name: 'ignored' },
  { type: 'delete' },
  { type: 'drop_table', id: 't3' }
] });
r = await call({ messages: hello });
assert.strictEqual(r.res.out.reply, 'Here you go');
assert.deepStrictEqual(r.res.out.actions, [{ type: 'create', name: 'Walk', frequency: 'daily' }, { type: 'update', id: 't1', weekdays: [1] }, { type: 'delete', id: 't2' }]);
console.log('ok proposals are validated');
assert.ok(!calls.some(c => c.body && c.body.max_tokens === 350), 'memory must skip action replies'); console.log('ok action replies skip memory update');
openaiMessage = toolReply('{not json');
r = await call({ messages: hello });
assert.strictEqual(r.res.code, 200); assert.deepStrictEqual(r.res.out.actions, []); console.log('ok malformed tool output is harmless');
openaiMessage = toolReply({ message: 'many', actions: Array.from({ length: 50 }, (_, i) => ({ type: 'create', name: 'n' + i })) });
r = await call({ messages: hello });
assert.strictEqual(r.res.out.actions.length, 20); console.log('ok proposals are capped');
openaiMessage = { content: 'hi' };
