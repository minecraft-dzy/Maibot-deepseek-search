'use strict';

class DeepSeekClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.DEEPSEEK_API_KEY || '';
    this.baseUrl = (options.baseUrl || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
    this.model = options.model || process.env.DEEPSEEK_MODEL || 'deepseek-flash';
    this.bossModel = options.bossModel || process.env.DEEPSEEK_BOSS_MODEL || 'deepseek-v4-pro';
    this.effort = options.effort || process.env.DEEPSEEK_EFFORT || 'high';
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  async streamChat({ messages, tools, signal, onReasoning, model }) {
    if (!this.apiKey) throw new Error('服务器未配置 DEEPSEEK_API_KEY');
    const activeModel = model || this.model;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 240000);
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const endpoint = this.baseUrl.endsWith('/v1')
      ? `${this.baseUrl}/chat/completions`
      : `${this.baseUrl}/chat/completions`;
    const payload = {
      model: activeModel,
      messages,
      stream: true,
      max_tokens: 8192,
      temperature: 0.65,
      reasoning_effort: this.effort,
    };
    if (tools && tools.length) {
      payload.tools = tools;
      payload.tool_choice = 'auto';
    }
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
    if (!response.ok) {
      clearTimeout(timeout);
      let body = '';
      try { body = await response.text(); } catch (_) { /* ignore */ }
      const err = new Error(`DeepSeek API ${response.status}: ${body.slice(0, 500) || response.statusText}`);
      err.status = response.status;
      throw err;
    }
    if (!response.body) {
      clearTimeout(timeout);
      throw new Error('DeepSeek API 未返回流式响应');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    let finished = false;
    let streamError = null;
    const toolCalls = new Map();

    const consumeLine = (line) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') {
        if (data === '[DONE]') finished = true;
        return;
      }
      let json;
      try {
        json = JSON.parse(data);
      } catch (_) {
        return;
      }
      if (json.error) {
        streamError = new Error(json.error.message || 'DeepSeek 流式响应错误');
        streamError.status = json.error.code || 500;
        return;
      }
      const choice = json.choices?.[0];
      if (!choice) return;
      const delta = choice.delta || {};
      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        if (onReasoning) onReasoning(delta.reasoning_content);
      }
      if (delta.content) content += delta.content;
      if (Array.isArray(delta.tool_calls)) {
        delta.tool_calls.forEach((call, fallbackIndex) => {
          const index = Number.isInteger(call.index) ? call.index : fallbackIndex;
          let current = toolCalls.get(index);
          if (!current) {
            current = { id: '', type: 'function', function: { name: '', arguments: '' } };
            toolCalls.set(index, current);
          }
          if (call.id) current.id = call.id;
          if (call.type) current.type = call.type;
          if (call.function?.name) {
            if (!current.function.name) current.function.name = call.function.name;
            else if (call.function.name !== current.function.name) current.function.name += call.function.name;
          }
          if (call.function?.arguments) current.function.arguments += call.function.arguments;
        });
      }
      if (choice.finish_reason) finished = true;
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          consumeLine(line);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) consumeLine(buffer.trim());
    } finally {
      clearTimeout(timeout);
      try { await reader.cancel(); } catch (_) { /* ignore */ }
    }
    if (streamError) throw streamError;

    const calls = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call], idx) => ({
        id: call.id || `call_${Date.now()}_${idx}`,
        type: 'function',
        function: {
          name: call.function.name,
          arguments: call.function.arguments || '{}',
        },
      }));

    return { content, reasoning, toolCalls: calls, finished };
  }
}

module.exports = DeepSeekClient;
