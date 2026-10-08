'use strict';
// Local stand-in for the Anthropic Messages API, used by the end-to-end tests with the
// real Claude Code CLI. It plays "Claude" from a script and records every request, so a
// test can prove which model each call used and when it arrived.
//
// Who is asking is decided by the FIRST user message of a request:
//   auto-mode classifier (security monitor)  -> allow / block verdict
//   E2E-SUB  -> subagent: optional tool calls (subTools), then SubagentHandback (when the
//               tool is offered, i.e. auto mode) or the text SUB-DONE
//   E2E-MAIN -> main thread: plays mainSteps one per response (Agent spawns, a single
//               tool call, or `say`: a text that ends the turn); an Agent tool_result
//               that asks for a re-issue with "model": "<m>" is answered per `reissue`
//               (follow | ignore | none). A later user prompt containing E2E-NEXT (TUI
//               runs with several prompts) moves on to the next step.
//   skill text with `node "<root>/scripts/pacer.js" <cmd>` (option skillMode) -> runs the
//               command(s) the skill names with the Bash tool, one per response, exactly
//               as written in the expanded skill (so ${CLAUDE_PLUGIN_ROOT} substitution
//               and allowed-tools are tested by the real CLI), then the text SKILL-DONE
//   anything else -> short text
// Auto mode: requests carrying `safeguards` get a server-side verdict per tool_use in
// message_delta.delta.safeguard_results (serverClassifier), unless it is 'none', which
// makes the CLI fall back to local classifier requests (localClassifier).
//
// Auth header VALUES are never stored: only header names, and whether the credential
// equals one of the fake ones the test injected (compared in memory).
const http = require('http');

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => {
    if (!b || typeof b !== 'object') return '';
    if (b.type === 'text') return b.text || '';
    if (b.type === 'tool_result') return `[tool_result ${b.tool_use_id} error=${!!b.is_error}] ${textOf(b.content)}`;
    return '';
  }).join('\n');
}

function systemText(body) {
  if (typeof body.system === 'string') return body.system;
  if (Array.isArray(body.system)) return body.system.map((b) => (b && b.text) || '').join('\n');
  return '';
}

// The CLI may put role:"system" messages between user turns; only user messages count.
function userMessages(body) {
  return (Array.isArray(body.messages) ? body.messages : []).filter((m) => m && m.role === 'user');
}

function firstUserText(body) {
  const m = userMessages(body)[0];
  return m ? textOf(m.content) : '';
}

function lastUserToolResults(body) {
  const msgs = userMessages(body);
  const last = msgs[msgs.length - 1];
  if (!last || !Array.isArray(last.content)) return [];
  return last.content.filter((b) => b && b.type === 'tool_result');
}

// Text of the newest user message (a new prompt, unlike a turn of tool results).
function lastUserText(body) {
  const msgs = userMessages(body);
  return msgs.length ? textOf(msgs[msgs.length - 1].content) : '';
}

function isClassifier(body) {
  const first = userMessages(body)[0];
  const firstBlock = first && Array.isArray(first.content) ? first.content[0] : null;
  return /^You are a security monitor/m.test(systemText(body))
    || (firstBlock && firstBlock.type === 'text' && firstBlock.text === '<transcript>\n')
    || /^<transcript>/.test(firstUserText(body));
}

// 2.1.291 delivers UserPromptSubmit additionalContext as "UserPromptSubmit hook additional
// context: <text>" inside a mid-conversation role:"system" message (older versions: in
// the user turn), so every message and the system prompt are searched.
function pacingContextOf(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (const t of [systemText(body), ...msgs.map((m) => textOf(m && m.content))]) {
    const hit = /UserPromptSubmit hook additional context: ([\s\S]*?)(?:\n\n|<\/system-reminder>|$)/.exec(t);
    if (hit) return hit[1].trim();
  }
  return null;
}

const REISSUE_HINT = /same Agent call|again|re-?issue/i;
const MODEL_HINT = /"model":\s*"([A-Za-z0-9.-]+)"/;

function createMock(opts = {}) {
  const o = {
    // Backwards compatible shorthand: { spawns, subagentType, requestModel }
    mainSteps: opts.mainSteps || [{ agents: opts.spawns === undefined ? 1 : opts.spawns, subagentType: opts.subagentType, requestModel: opts.requestModel }],
    subTools: opts.subTools || [],
    reissue: opts.reissue || 'follow',
    maxReissues: opts.maxReissues || 3,
    serverClassifier: opts.serverClassifier === undefined ? 'not_flagged' : opts.serverClassifier,
    localClassifier: opts.localClassifier || 'allow',
    fakeSecrets: new Set(opts.fakeSecrets || []),
    rateLimitHeaders: opts.rateLimitHeaders || null,
    skillMode: !!opts.skillMode,
    resultChars: opts.resultChars || 600,
  };
  const requests = [];
  const st = { n: 0, toolCounter: 0, step: -1, issued: {}, reissueDepth: {}, finished: false };

  const nextId = (prefix) => { st.toolCounter += 1; return `toolu_${prefix}_${st.toolCounter}`; };

  function agentBlocks(step) {
    const blocks = [];
    const n = step.agents;
    for (let i = 0; i < n; i++) {
      const tag = `s${st.step}-${i + 1}`;
      const input = {
        description: `E2E task ${tag}`,
        prompt: `E2E-SUB ${tag}: answer with one word.`,
        subagent_type: step.subagentType || 'Explore',
        run_in_background: step.runInBackground === undefined ? false : step.runInBackground,
      };
      if (step.requestModel) input.model = step.requestModel;
      const id = nextId('e2e');
      st.issued[id] = input;
      st.reissueDepth[id] = 0;
      blocks.push({ type: 'tool_use', id, name: 'Agent', input });
    }
    return blocks;
  }

  function playStep() {
    const step = o.mainSteps[st.step];
    if (!step) {
      st.finished = true;
      return { role: 'main', action: 'final', blocks: [{ type: 'text', text: 'MAIN-DONE' }], stop: 'end_turn' };
    }
    if (step.agents) return { role: 'main', action: 'spawn', blocks: agentBlocks(step), stop: 'tool_use' };
    if (step.say) return { role: 'main', action: 'say', blocks: [{ type: 'text', text: step.say }], stop: 'end_turn' };
    return { role: 'main', action: 'tool', blocks: [{ type: 'tool_use', id: nextId('main'), name: step.tool, input: step.input }], stop: 'tool_use' };
  }

  function mainTurn(body, toolNames) {
    if (!toolNames.includes('Agent') && o.mainSteps.some((s) => s.agents)) {
      return { role: 'main', action: 'no-agent-tool', blocks: [{ type: 'text', text: 'NO-AGENT-TOOL' }], stop: 'end_turn' };
    }
    const results = lastUserToolResults(body);
    if (st.step < 0) { st.step = 0; return playStep(); }
    if (!results.length) {
      if (/E2E-NEXT/.test(lastUserText(body))) { st.step += 1; return playStep(); }
      // A user turn without tool results after the start (e.g. an injected agent message).
      return { role: 'main', action: 'extra', blocks: [{ type: 'text', text: 'MAIN-DONE' }], stop: 'end_turn' };
    }
    if (o.reissue !== 'none') {
      const blocks = [];
      for (const r of results) {
        const txt = textOf(r.content);
        const m = MODEL_HINT.exec(txt);
        const prev = st.issued[r.tool_use_id];
        if (!r.is_error || !m || !REISSUE_HINT.test(txt) || !prev) continue;
        const depth = (st.reissueDepth[r.tool_use_id] || 0) + 1;
        if (depth > o.maxReissues) continue; // the plugin keeps asking: stop, the test reports the loop
        const input = o.reissue === 'follow' ? { ...prev, model: m[1] } : { ...prev };
        const id = nextId('e2e');
        st.issued[id] = input;
        st.reissueDepth[id] = depth;
        blocks.push({ type: 'tool_use', id, name: 'Agent', input });
      }
      if (blocks.length) return { role: 'main', action: 'reissue', blocks, stop: 'tool_use' };
    }
    st.step += 1;
    return playStep();
  }

  function subTurn(body, toolNames) {
    const done = userMessages(body).reduce((acc, m) => acc + (Array.isArray(m.content) ? m.content.filter((b) => b && b.type === 'tool_result').length : 0), 0);
    if (done < o.subTools.length) {
      const spec = o.subTools[done];
      return { role: 'sub', action: 'tool', blocks: [{ type: 'tool_use', id: nextId('sub'), name: spec.tool, input: spec.input }], stop: 'tool_use' };
    }
    if (toolNames.includes('SubagentHandback')) {
      return { role: 'sub', action: 'handback', blocks: [{ type: 'tool_use', id: nextId('handback'), name: 'SubagentHandback', input: { message: 'SUB-DONE' } }], stop: 'tool_use' };
    }
    return { role: 'sub', action: 'final', blocks: [{ type: 'text', text: 'SUB-DONE' }], stop: 'end_turn' };
  }

  // Local classifier (fallback when the reply carried no server verdict). Stage 1 stops at
  // "</severity>", so the answer ends right before it, as the real API would.
  function classifierTurn(body) {
    const block = o.localClassifier === 'block';
    const stop = Array.isArray(body.stop_sequences) && body.stop_sequences.length ? body.stop_sequences[0] : null;
    const stage = stop ? 1 : 2;
    let text = block ? '<severity>95</severity><category>Irreversible Local Destruction</category>' : '<severity>5</severity>';
    if (stop && text.includes(stop)) text = text.slice(0, text.indexOf(stop));
    return {
      role: 'classifier', action: `stage${stage}`, verdict: block ? 'block' : 'allow',
      blocks: [{ type: 'text', text }], stop: stop ? 'stop_sequence' : 'end_turn', stopSequence: stop,
    };
  }

  function verdictFor(block, body) {
    const v = typeof o.serverClassifier === 'function' ? o.serverClassifier(block, body) : o.serverClassifier;
    if (v === 'flagged') return { type: 'evaluated', outcome: 'flagged', explanation: 'mock server classifier flagged this call' };
    if (v === 'skipped') return { type: 'skipped' };
    return { type: 'evaluated', outcome: 'not_flagged' };
  }

  function withSafeguards(p, body) {
    const wants = Array.isArray(body.safeguards) && body.safeguards.some((x) => x && x.type === 'dangerous_tool_use');
    if (!wants || o.serverClassifier === 'none') return p;
    const toolUses = {};
    for (const b of p.blocks) if (b.type === 'tool_use') toolUses[b.id] = verdictFor(b, body);
    return { ...p, safeguardResults: [{ type: 'dangerous_tool_use', status: { type: 'available', tool_uses: toolUses } }] };
  }

  // Commands of an expanded quota-pacer skill. setup: install, or uninstall when the
  // argument line says so; status: every command in the order written (status, doctor).
  function skillCommands(body) {
    const texts = userMessages(body).map((m) => (Array.isArray(m.content)
      ? m.content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n')
      : textOf(m.content))).join('\n');
    const cmds = [...texts.matchAll(/node "([^"\n]*scripts\/pacer\.js)" (install|uninstall|status|doctor)/g)].map((m) => m[0]);
    if (!cmds.length) return null;
    const arg = /Argument: `([^`]*)`/.exec(texts);
    if (arg) {
      const want = arg[1].trim() === 'uninstall' ? 'uninstall' : 'install';
      return cmds.filter((c) => c.endsWith(` ${want}`)).slice(0, 1);
    }
    return [...new Set(cmds)];
  }

  function skillTurn(body, cmds) {
    const done = userMessages(body).reduce((acc, m) => acc + (Array.isArray(m.content) ? m.content.filter((b) => b && b.type === 'tool_result').length : 0), 0);
    if (done < cmds.length) {
      return { role: 'skill', action: 'bash', blocks: [{ type: 'tool_use', id: nextId('skill'), name: 'Bash', input: { command: cmds[done], description: 'quota-pacer skill command' } }], stop: 'tool_use' };
    }
    return { role: 'skill', action: 'done', blocks: [{ type: 'text', text: 'SKILL-DONE' }], stop: 'end_turn' };
  }

  function plan(body) {
    if (isClassifier(body)) return classifierTurn(body);
    const first = firstUserText(body);
    const toolNames = (body.tools || []).map((t) => t && t.name);
    const skill = o.skillMode ? skillCommands(body) : null;
    let p;
    if (skill) p = skillTurn(body, skill);
    else if (first.includes('E2E-SUB')) p = subTurn(body, toolNames);
    else if (first.includes('E2E-MAIN')) p = mainTurn(body, toolNames);
    else p = { role: 'other', action: 'text', blocks: [{ type: 'text', text: 'ok' }], stop: 'end_turn' };
    return withSafeguards(p, body);
  }

  function authInfo(h) {
    const out = {};
    if (h['x-api-key'] !== undefined) out.xApiKey = { fake: o.fakeSecrets.has(String(h['x-api-key'])) };
    if (h.authorization !== undefined) {
      const m = /^(\S+)\s+(.*)$/.exec(String(h.authorization));
      out.authorization = { scheme: m ? m[1] : '?', fake: o.fakeSecrets.has(m ? m[2] : String(h.authorization)) };
    }
    return out;
  }

  function sse(res, body, p, n, headers) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'request-id': `req_mock_${n}`, ...headers });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('message_start', { type: 'message_start', message: { id: `msg_mock_${n}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
    p.blocks.forEach((b, i) => {
      if (b.type === 'text') {
        send('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
        send('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text } });
      } else {
        send('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
        send('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
      }
      send('content_block_stop', { type: 'content_block_stop', index: i });
    });
    const delta = { stop_reason: p.stop, stop_sequence: p.stopSequence || null };
    if (p.safeguardResults) delta.safeguard_results = p.safeguardResults;
    send('message_delta', { type: 'message_delta', delta, usage: { output_tokens: 10 } });
    send('message_stop', { type: 'message_stop' });
    res.end();
  }

  const server = http.createServer((req, res) => {
    req.on('error', () => {});
    res.on('error', () => {});
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      st.n += 1;
      const n = st.n;
      const t = Date.now();
      const url = req.url || '';
      const rec = { n, t, method: req.method, path: url.replace(/\?.*$/, ''), headerNames: Object.keys(req.headers).sort(), auth: authInfo(req.headers) };
      if (req.method !== 'POST' || !/^\/v1\/messages(\?|$)/.test(url)) {
        rec.role = 'non-messages';
        requests.push(rec);
        if (url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 100 })); return; }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'mock: not implemented' } }));
        return;
      }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
      let p;
      try { p = plan(body); } catch (e) { p = { role: 'mock-error', action: String(e && e.message), blocks: [{ type: 'text', text: 'mock error' }], stop: 'end_turn' }; }
      const first = firstUserText(body);
      const subKey = /E2E-SUB (\S+):/.exec(first);
      Object.assign(rec, {
        role: p.role,
        action: p.action,
        verdict: p.verdict || null,
        subKey: p.role === 'sub' && subKey ? subKey[1] : null,
        model: body.model,
        stream: !!body.stream,
        tools: (body.tools || []).map((x) => x && x.name),
        safeguardsRequested: Array.isArray(body.safeguards) ? body.safeguards.map((x) => x && x.type) : null,
        safeguardResults: p.safeguardResults ? p.safeguardResults[0].status.tool_uses : null,
        answered: p.blocks.map((b) => (b.type === 'text' ? { text: b.text } : { toolUse: b.name, id: b.id, input: b.input })),
        spawned: p.blocks.filter((b) => b.type === 'tool_use' && b.name === 'Agent').map((b) => ({ id: b.id, ...b.input })),
        toolResults: lastUserToolResults(body).map((b) => ({ id: b.tool_use_id, isError: !!b.is_error, text: textOf(b.content).slice(0, o.resultChars) })),
        pacingContext: p.role === 'main' ? pacingContextOf(body) : null,
      });
      const headers = o.rateLimitHeaders ? o.rateLimitHeaders() : {};
      rec.rateLimitHeaders = Object.keys(headers).filter((k) => /^anthropic-ratelimit-unified-/.test(k)).length;
      requests.push(rec);
      if (body.stream) { sse(res, body, p, n, headers); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_mock_${n}`, ...headers });
      res.end(JSON.stringify({ id: `msg_mock_${n}`, type: 'message', role: 'assistant', model: body.model, content: p.blocks, stop_reason: p.stop, stop_sequence: p.stopSequence || null, usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }));
    });
  });
  server.on('connection', (sock) => sock.on('error', () => {}));
  server.on('clientError', (err, sock) => { try { sock.destroy(); } catch { /* ignore */ } });

  return {
    requests,
    state: st,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

module.exports = { createMock, textOf, firstUserText, lastUserText, lastUserToolResults, isClassifier, pacingContextOf };
