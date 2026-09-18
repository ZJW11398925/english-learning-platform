// web/units/write/engine.mjs
//
// 引擎层：把「读这一版」与「改这一版」各自做成**一次**模型调用的完整动作——
// 组提示词 → 调模型 → 找 JSON → 归一形状 → 机械校验。任何一关不过就**如实失败**。
//
// ── 每个方法恰好一次模型调用 ──────────────────────────────────────────────────
// 这不是优化，是**成本契约**（`DEC-…db.192` 的四处冻结之一：一个回合 ≤2 次调用）。
// 调用次数是用户自己掏钱买的东西，所以它必须是**程序持有**的事实，不是提示词里的自律：
// `createEngine` 内部计数（`callsTotal`），`./flow.mjs` 与 `./index.mjs` 读它来断言预算。
// 这一层**不做重试**：重试就是第二次调用，那是另一个决策（本轮没有授权，见报告）。
//
// ── 失败分档的两段来源 ────────────────────────────────────────────────────────
//   · 网络/信封/超时 → `./client.mjs` 的四档（`no_key`/`timeout`/`request_failed`/`response_invalid`）
//   · 形状与机械校验 → 本层新增两档：`parse_failed`（找不出 JSON 对象）与
//     `validation_failed`（找出来了，但过不了 V1–V5 那几条）——`detail` 就是违规清单的串接。
//   两段**绝不合并**：前者要改的是模型契约/网络，后者要改的是提示词与教学内容，
//   混成一档之后，看失败分布的人不知道该去改哪儿。
//
// ── 为什么 `validation_failed` 也必须算进"调用次数" ──────────────────────────
// 那一次调用**真的花掉了钱**。把它排除在计数外，成本账就会少报——而"调用预算"这条判据的
// 全部意义就是让钱花在哪里看得见。所以计数在**发出请求那一刻**加，不看结果。
//
// 纯逻辑模块：零浏览器 API（`callModel` 与 `now` 都是注入点）——可在 Node 中直接测。
import {
  buildReadMessages, buildReviseMessages,
} from './prompt.mjs';
import { normalizeRead, normalizeRevise, parseEnvelope } from './parse.mjs';
import { validateRead, validateRevise } from './validate.mjs';

/**
 * `createEngine` 的两档**本层新增**失败原因（网络/信封的四档在 `./client.mjs`）。
 * 冻结：这是统计口径的一部分。
 */
export const ENGINE_FAIL_REASONS = Object.freeze({
  PARSE_FAILED: 'parse_failed',
  VALIDATION_FAILED: 'validation_failed',
});

/** `callModel` 可能给的档位（`./client.mjs` 的四档）——本层原样透传，不改写。 */
const CLIENT_REASONS = new Set(['no_key', 'timeout', 'request_failed', 'response_invalid']);

/** 把一条失败原样上抛成 `{ok:false, reason, detail}`（不吞、不换档、不补内容）。 */
function fail(reason, detail) {
  return { ok: false, reason, detail: String(detail ?? reason) };
}

/** 违规清单 → 一行可读的 detail（每条都点名判据，能直接进日志）。 */
function joinViolations(violations) {
  return violations.join(' | ');
}

/**
 * 造一个写作引擎。
 *
 * @param {object} input
 *   - `callModel`：**必传**的模型出口（生产是 `./client.mjs` 的 `callModel`，测试注入桩）。
 *     它的返回值形状就是 `client.mjs` 的契约（`{ok:true,content,usage,latencyMs}` /
 *     `{ok:false,reason,detail}`）。
 *   - `now`：时钟注入点（`Date.now` 形状）。本层只用它做**调用次数**的账，
 *     不参与任何内容判断。
 * @returns {{
 *   read: (input: object) => Promise<object>,
 *   revise: (input: object) => Promise<object>,
 *   state: () => {callsTotal: number, callsThisRound: number, latencyMsTotal: number, lastLatencyMs: number, resetRound: () => void},
 * }}
 */
export function createEngine({ callModel, now = Date.now } = {}) {
  if (typeof callModel !== 'function') {
    // 引擎没有模型出口是**装配错误**，不是用户情形：当场响亮抛出。
    throw new TypeError('createEngine: callModel 必须是函数（模型经注入进来）');
  }
  const clock = typeof now === 'function' ? now : Date.now;

  /** 累计计数（跨回合）。`callsThisRound` 由 `resetRound()` 清零——回合边界由 `./flow.mjs` 划。 */
  let callsTotal = 0;
  let callsThisRound = 0;
  let latencyMsTotal = 0;
  let lastLatencyMs = 0;

  /** 记一次**真的发出去的**调用（在请求那一刻记，不看结果：钱是按次花的）。 */
  function noteCall(latencyMs) {
    callsTotal += 1;
    callsThisRound += 1;
    const ms = Number.isFinite(latencyMs) ? latencyMs : 0;
    lastLatencyMs = ms;
    latencyMsTotal += ms;
    // `clock` 在这里只是"这一次调用发生的时间"的账（报告里对得上时间线），
    // 不参与任何判据——留着它是为了让注入的假时钟也能解释"调用发生在哪一刻"。
    return clock();
  }

  /** 公共尾巴：调模型 → 找 JSON → 归一 → 校验。三个方法共用，免得两条腿各写一套。 */
  async function runOnce({ messages, apiKey, normalize, validate, source, extra }) {
    const res = await callModel({
      messages,
      apiKey,
    });
    if (!res || res.ok !== true) {
      const reason = CLIENT_REASONS.has(res?.reason) ? res.reason : 'request_failed';
      // `no_key` **不计费**：那一枪根本没开（`client.callModel` 的第一道闸拦下的，一个请求都没发）。
      // 其余失败（超时/发不出去/信封不对/校验不过）**都计**——请求真的出去了，钱真的花了。
      // "调用预算"这条判据的全部意义就是让钱花在哪里看得见，所以计数不看结果、只看有没有发。
      if (reason !== 'no_key') noteCall(res?.latencyMs);
      return fail(reason, res?.detail ?? '模型调用失败（未给出 detail）');
    }
    noteCall(res.latencyMs);

    const obj = parseEnvelope(res.content);
    if (obj === null) {
      return fail(
        ENGINE_FAIL_REASONS.PARSE_FAILED,
        `模型响应里找不到一个 JSON 对象（content 前 120 字：${String(res.content).slice(0, 120)}）`,
      );
    }
    const normalized = normalize(obj);
    if (normalized === null) {
      return fail(
        ENGINE_FAIL_REASONS.PARSE_FAILED,
        '模型响应的字段形状不合契约（canHelp/canTeach 不是布尔，或系统版不是非空字符串）',
      );
    }
    const verdict = validate(normalized, source);
    if (!verdict.ok) {
      return fail(ENGINE_FAIL_REASONS.VALIDATION_FAILED, joinViolations(verdict.violations));
    }
    return {
      ok: true,
      ...extra(normalized),
      usage: res.usage ?? null,
      latencyMs: Number.isFinite(res.latencyMs) ? res.latencyMs : null,
    };
  }

  return {
    /**
     * 「读这一版」：**恰好一次**模型调用。
     *
     * @param {object} input `{chinese, material, draft, apiKey}`
     * @returns {Promise<{ok:true, read: object, usage: object|null, latencyMs: number|null}
     *   | {ok:false, reason: string, detail: string}>}
     */
    async read({ chinese, material = null, draft = '', apiKey } = {}) {
      return runOnce({
        messages: buildReadMessages({ chinese, material, draft }),
        apiKey,
        normalize: normalizeRead,
        validate: validateRead,
        // V1–V3 的 source = **他写的那一版**（不是中文原话、不是素材）——
        // 传错 source 会让判据变成假绿，见 `./validate.mjs` 文件头。
        source: draft,
        extra: (read) => ({ read }),
      });
    },

    /**
     * 「改这一版」：**恰好一次**模型调用。
     *
     * @param {object} input `{chinese, material, draft, pickedTeachPoint, apiKey}`
     * @returns {Promise<{ok:true, revise: object, usage: object|null, latencyMs: number|null}
     *   | {ok:false, reason: string, detail: string}>}
     */
    async revise({
      chinese = null, material = null, draft, pickedTeachPoint = null, apiKey,
    } = {}) {
      return runOnce({
        messages: buildReviseMessages({
          chinese, material, draft, pickedTeachPoint,
        }),
        apiKey,
        normalize: normalizeRevise,
        validate: validateRevise,
        source: draft,
        extra: (revise) => ({ revise }),
      });
    },

    /**
     * 计数快照（**程序持有的事实**：调用预算是判据，不是提示词里的自律）。
     * `resetRound()` 由 `./flow.mjs` 在回合边界调用（新句子 / 揭开之后）。
     */
    state() {
      return {
        callsTotal,
        callsThisRound,
        latencyMsTotal,
        lastLatencyMs,
        resetRound() {
          callsThisRound = 0;
        },
      };
    },
  };
}
