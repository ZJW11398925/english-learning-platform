// web/units/chat/engine.mjs
//
// 对话引擎：把「回一句」与「生成一张人设卡」各自做成**一次**模型调用的完整动作。
// 照 `../write/engine.mjs` 的先例——纯逻辑、零 DOM、模型经注入、每个方法恰好一次
// 调用、失败如实分档、不重试（重试就是第二次调用，是花钱的决策，本切片没授权）。
//
// ── 聊天腿不解析模型输出 ─────────────────────────────────────────────────────
// 回复是自然语言，引擎**原样透出 content**（不像写作链路那样找 JSON、跑机械校验）：
// VS1 没有「回复必须长什么样」的契约，任何「帮模型修一下」的动作都是编内容。
// 失败分档只来自 `./client.mjs` 的五档，本层不新增。
//
// ── 人设生成腿多两档 ─────────────────────────────────────────────────────────
// `parse_failed`：找不出 JSON 对象 / 归一不出一张卡（复用 `../write/parse.mjs`
// 的 `parseEnvelope` 找 JSON、`./persona.mjs` 的 `normalizePersona` 归一——
// 尺子只有一把，不另写一份）。
//
// ── 调用计数（成本契约）──────────────────────────────────────────────────────
// `no_key` / `no_endpoint` 那一枪根本没开（client 第一道闸拦的，零请求），**不计**；
// 其余（含超时/失败/校验不过）**都计**——请求真的出去了，钱真的花了。
// VS1 **不设调用数量上限**（STUB 边界如实登记：成本由用户自控 + 透明仪表承担，
// 不由程序配额承担）；计数存在是为了仪表与探针有据可查。
//
// 纯逻辑模块：`callModel` 与 `now` 都是注入点——Node 里直接测、探针里包记录壳。

import { buildChatMessages, buildPersonaGenMessages } from './prompt.mjs';
import { normalizePersona } from './persona.mjs';
import { parseEnvelope } from '../write/parse.mjs';

/** 人设生成腿的**本层**失败档（聊天腿的失败全部来自 `./client.mjs` 的五档）。 */
export const CHAT_ENGINE_FAIL_REASONS = Object.freeze({
  PARSE_FAILED: 'parse_failed',
});

/** `callModel` 的五档——本层原样透传，不改写。 */
const CLIENT_REASONS = new Set([
  'no_endpoint', 'no_key', 'timeout', 'request_failed', 'response_invalid',
]);

const fail = (reason, detail) => ({ ok: false, reason, detail: String(detail ?? reason) });

/**
 * 造一个对话引擎。
 *
 * @param {object} input
 *   - `callModel`：**必传**模型出口（生产是 `./client.mjs` 的 `callModel`；测试/探针注入桩）。
 *   - `now`：时钟注入点（`Date.now` 形状），只用于记账，不参与内容判断。
 * @returns {{
 *   reply: (input: object) => Promise<object>,
 *   generatePersona: (input: object) => Promise<object>,
 *   state: () => {callsTotal: number, repliesOk: number, latencyMsTotal: number, lastLatencyMs: number, reset: () => void},
 * }}
 */
export function createChatEngine({ callModel, now = Date.now } = {}) {
  if (typeof callModel !== 'function') {
    throw new TypeError('createChatEngine: callModel 必须是函数（模型经注入进来）');
  }
  const clock = typeof now === 'function' ? now : Date.now;

  let callsTotal = 0;
  let repliesOk = 0;
  let latencyMsTotal = 0;
  let lastLatencyMs = 0;

  /** 记一次真的发出去的调用（不看结果：钱是按次花的）。 */
  function noteCall(latencyMs) {
    callsTotal += 1;
    const ms = Number.isFinite(latencyMs) ? latencyMs : 0;
    lastLatencyMs = ms;
    latencyMsTotal += ms;
    return clock();
  }

  /** client 失败的公共处理：透传档位与 detail；没发出去的那枪不计数。 */
  function clientFail(res) {
    const reason = CLIENT_REASONS.has(res?.reason) ? res.reason : 'request_failed';
    if (reason !== 'no_key' && reason !== 'no_endpoint') noteCall(res?.latencyMs);
    return fail(reason, res?.detail ?? '模型调用失败（未给出 detail）');
  }

  return {
    /**
     * 「回一句」：恰好一次模型调用，回复原样透出。
     *
     * @param {object} input
     *   - `persona` / `history` / `userText` / `replyLanguage`：见 `./prompt.mjs`。
     *   - `apiBase` / `apiKey` / `model`：设置三件套（装配层在调用那一刻读好传入）。
     * @returns {Promise<{ok:true, reply: string, usage: object|null, latencyMs: number|null}
     *   | {ok:false, reason: string, detail: string}>}
     */
    async reply({ persona, history, userText, replyLanguage, apiBase, apiKey, model } = {}) {
      let messages;
      try {
        messages = buildChatMessages({ persona, history, userText, replyLanguage });
      } catch (err) {
        // 组装失败是装配错误（空文本/人设没归一），不是用户情形：响亮抛出，
        // 不伪装成一次模型失败（那会把 bug 记到模型头上）。
        throw err;
      }
      const res = await callModel({ messages, apiBase, apiKey, model });
      if (res === null || res === undefined || res.ok !== true) return clientFail(res);
      noteCall(res.latencyMs);
      repliesOk += 1;
      return {
        ok: true,
        reply: res.content,
        usage: res.usage ?? null,
        latencyMs: Number.isFinite(res.latencyMs) ? res.latencyMs : null,
      };
    },

    /**
     * 「生成一张人设卡」：恰好一次模型调用（JSON 腿）。
     * @param {object} input `{description, apiBase, apiKey, model}`
     * @returns {Promise<{ok:true, persona: object, usage: object|null, latencyMs: number|null}
     *   | {ok:false, reason: string, detail: string}>}
     */
    async generatePersona({ description, apiBase, apiKey, model } = {}) {
      let messages;
      try {
        messages = buildPersonaGenMessages({ description });
      } catch (err) {
        throw err; // 同上：装配错误当场响，不冒充模型失败
      }
      const res = await callModel({ messages, apiBase, apiKey, model, jsonMode: true });
      if (res === null || res === undefined || res.ok !== true) return clientFail(res);
      noteCall(res.latencyMs);

      const obj = parseEnvelope(res.content);
      if (obj === null) {
        return fail(
          CHAT_ENGINE_FAIL_REASONS.PARSE_FAILED,
          `模型响应里找不到一个 JSON 对象（content 前 120 字：${String(res.content).slice(0, 120)}）`,
        );
      }
      const persona = normalizePersona(obj);
      if (persona === null) {
        return fail(
          CHAT_ENGINE_FAIL_REASONS.PARSE_FAILED,
          '人设卡形状不对：name / bio / tone / difficulty 四个字段都必须是非空字符串',
        );
      }
      return {
        ok: true,
        persona,
        usage: res.usage ?? null,
        latencyMs: Number.isFinite(res.latencyMs) ? res.latencyMs : null,
      };
    },

    /** 计数快照（程序持有的事实：仪表与探针都读它，不读界面的自觉）。 */
    state() {
      return {
        callsTotal,
        repliesOk,
        latencyMsTotal,
        lastLatencyMs,
        reset() {
          callsTotal = 0;
          repliesOk = 0;
          latencyMsTotal = 0;
          lastLatencyMs = 0;
        },
      };
    },
  };
}
