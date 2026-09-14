// server/feedback-upstream.mjs
//
// 造句反馈的上游调用：把「词 + 场景 + 学习者原句」发给文本模型，取回**已过信封校验**的判定。
//
// 为什么单独一个模块（与 `recognize-upstream.mjs` 同一个理由）：这一层承载的是**模型契约**
// （请求体形状、响应信封怎么校验、上限在哪条腿上），而契约是会被"改坏但测试全绿"的地方——
// 它必须能脱离 HTTP 单独测、单独变异。路由层只剩"解析 JSON body + 打状态码"。
//
// 密钥只在服务端（共享上下文全局约束 1）：本模块从 `env` 拿 Key，只往**上游**发；
// 返回值里绝不回带任何与密钥有关的字段，日志里也不打印它。
//
// ── 信封与语义的分工（本模块最要紧的一条）────────────────────────────────────
// 本模块只管**信封**：上游 HTTP 状态、`choices[0].message.content` 在不在、它是不是 JSON、
// 解出来是不是一个对象。任一项不成立 → `upstream_invalid`（"要改的是模型契约"那一档）。
//
// 四个字段的**语义**（verdict 取值、correct↔none 的搭配、rewrite 非空…）**一律不在这里判**：
// 那是 `web/units/feedback.mjs` 的 `validateFeedback`（Task 4，冻结）的职责，客户端拿它当闸门。
// 两处各判一套的后果是它们迟早漂移——同一个响应在服务端被判合法、在客户端被判非法（或反过来），
// 而两边都"有测试"。
//
// 为什么服务端还要管信封：`response_format: { type: 'json_object' }` 保证的是**语法**，不是语义；
// 而"网关吐了一页 HTML""模型吐了一段散文"这类失败必须在服务端就响亮地变成 502，
// 不能让一个 `200 {ok:true}` 带着垃圾往下走（全局约束 3：失败不得静默降级为成功）。
//
// 已核实的模型契约（2026-09-14，官方文档，见 shared-context「模型服务」一节）：
//   · `POST ${DEEPSEEK_API_BASE}/chat/completions`，OpenAI 格式，`Authorization: Bearer ${KEY}`
//   · 模型取 `${DEEPSEEK_MODEL}`（= `deepseek-flash`）；纯文本判定不需要 vision
//   · 支持 JSON Output（`response_format`）——本任务按控制器要求用它兜底语法
//
// 另有一条与模型契约无关、但同样必须守住的：**这一腿有上限**（`UPSTREAM_TIMEOUT_MS`）。
// `fetch` 默认不超时，半开的上游会把这条路由永久挂住、连接与内存都收不回来。
// 上限到点在 `fetch()` 那一句和 `res.json()` 那一句**都算"超时"**（`upstream_failed`）：
// 后者是"响应头已经到了、body 还在流"（一次上游停滞），绝不是 `upstream_invalid`
// ——把停滞记成"契约不对"，排查的人会去改提示词与模型（Task 7 复审 Important 1 的同一课）。

/** 上游返回的东西不是我们能用的**信封**时抛出的错误上挂的 `code`。 */
export const UPSTREAM_INVALID = 'upstream_invalid';
/** 上游调用本身失败（网络错、非 2xx、**超时**）时挂的 `code`——与"信封不对"分开报。 */
export const UPSTREAM_FAILED = 'upstream_failed';

/**
 * 服务端这一腿的上游请求上限（毫秒）——**首轮设定值**，不是定论：第一周用真实数据标定，
 * 每次调整都要记入变更记录（与 `web/units/frame-qc.mjs` 的阈值、以及客户端那条腿同一条纪律）。
 *
 * 为什么必须有它：`fetch` 默认**没有**超时。上游连接半开（不回、也不断）时这个 Promise 会
 * 永久 pending，这条路由就一直挂在半空、连接与内存都收不回来。
 *
 * 与客户端那条腿的关系（**硬要求，有跨模块用例钉住**）：本值必须**小于**客户端的
 * `FEEDBACK_REQUEST_TIMEOUT_MS`（`web/units/compose.mjs`）。于是链路是：
 *   上游超时 → 本模块抛 `upstream_failed` → 路由回 `502 {ok:false,error:'upstream_failed'}`
 *   → 客户端收到 HTTP 非 2xx → 落 `feedback_pending{reason:'http_error'}`。
 * 顺序反过来的话，所有"模型慢"都只会长成同一个样子——"客户端自己等烦了"，而服务端什么都没记，
 * 分不清模型慢、服务端挂掉还是网络断。
 *
 * 取值依据：实弹探针 7 次真实调用实测端到端 1068–3439 ms（task-8-report 实弹探针一节），
 * **最慢一次服务端自报 latency_ms = 3210ms**；20s 对它约有 6 倍余量，也容得下模型多写几十个
 * token 的改写建议（实测 completion_tokens 从 40 一路到 393——"note 写长一点"就能让一次调用
 * 慢下来，而那不是失败）。
 * 调大 = 学习者对着"提交中"干等更久（客户端那条腿也得跟着放宽）；调小 = 真实模型偶发变慢
 * 被误报成上游失败（`feedback_pending` 偏高，而真凶只是模型这一趟慢）。
 *
 * 可在调用处覆盖（`feedbackUpstream({ timeoutMs })`，路由层由 `createApp({ upstreamTimeoutMs })`
 * 注入），测试用一个小值即可，不必真等生产上限。
 */
export const UPSTREAM_TIMEOUT_MS = 20_000;

/**
 * 强约束提示词的**四条规则**，逐条单独成常量的理由：每一条都对应一个必须成立的行为，
 * 而"整段提示词里出现过某几个字"这种断言拦不住"把其中一条删掉"（剩下的部分照样能让正则匹配上）。
 * 拆开之后每条都能被单独断言，也就能被变异探针单独钉住——提示词里被删掉一句，
 * 测试必须响（否则那句话只是写在注释里，不是契约）。
 *
 * 四条分别管：①判定与错误类型只能取那几个值；②`correct` 的搭配关系；
 * ③`flawed` 必须指出问题并给改写；④`uncertain` 是**合法答案**，且照样要给改写建议。
 */
export const FEEDBACK_RULE_VERDICTS = '- "verdict": one of "correct", "flawed", "uncertain".';
export const FEEDBACK_RULE_ERROR_TYPES = '- "error_type": one of "word_choice", "collocation", "grammar", "none".';
export const FEEDBACK_RULE_CORRECT = [
  '- "verdict":"correct" MUST come with "error_type":"none".',
].join('\n');
export const FEEDBACK_RULE_FLAWED = [
  '- "verdict":"flawed" MUST name the single most important problem in "error_type"',
  '  (never "none"), and MUST give a corrected sentence in "rewrite".',
].join('\n');
export const FEEDBACK_RULE_UNCERTAIN = [
  '- Use "uncertain" only when you genuinely cannot judge the sentence. It is a real,',
  '  acceptable answer — never guess a confident wrong verdict instead.',
  '  When you answer "uncertain", STILL put a suggested rewrite in "rewrite"',
  '  (keep the learner\'s own meaning), and say in "note" why you are unsure.',
].join('\n');

/**
 * 提示词：强约束"只输出这四个字段"，并要求 `uncertain` 时**也给**改写建议。
 *
 * 最后那条是有意的（控制器追加要求 A1）：设计文档 §4.2 要求"拿不准"时仍给改写建议，
 * 而 Task 4 的校验器**允许** `uncertain + rewrite: null`（契约如此，且有测试钉住）。
 * 两条并存时的正确处置是**用提示词去要**，而不是回头收紧校验器——收紧会把一份契约合法的
 * 响应判成不可用，等于用"缺数据"换"看起来整齐"。校验器仍是权威：它放行的东西才往下走。
 *
 * 提示词只能"劝"，判定与校验权都在客户端（这里不引入任何判定逻辑）。
 */
export const FEEDBACK_PROMPT = [
  'You are an English tutor for an adult learner who is practising one target vocabulary word.',
  'The learner wrote their own sentence using the target word.',
  'Judge the sentence, then return STRICT JSON only, no prose, in exactly this shape:',
  '{"verdict":"flawed","error_type":"word_choice","rewrite":"I use a mug.","note":"…"}',
  'It must be a JSON object with exactly these four fields:',
  FEEDBACK_RULE_VERDICTS,
  FEEDBACK_RULE_ERROR_TYPES,
  '- "rewrite": a better version of the sentence as a plain string, or null.',
  '- "note": one short sentence for the learner, in Chinese, no jargon.',
  'Rules:',
  FEEDBACK_RULE_CORRECT,
  FEEDBACK_RULE_FLAWED,
  FEEDBACK_RULE_UNCERTAIN,
  '- Never add extra fields or commentary outside the JSON object.',
].join('\n');

/** 上游返回的东西不是我们能用的**信封**时抛出的错误。 */
function invalid(message) {
  const err = new Error(message);
  err.code = UPSTREAM_INVALID;
  return err;
}

/** 上游调用本身失败（网络错、非 2xx、超时）时抛出的错误。 */
function failed(message) {
  const err = new Error(message);
  err.code = UPSTREAM_FAILED;
  return err;
}

/**
 * 这次中止/异常是不是"我们设的上限到点了"（与 `recognize-upstream.mjs` / `web/units/recognize.mjs`
 * 同一判定，理由也同）。
 *
 * 上限到点可能发生在 `fetch()` 那一句（连接都没建起来），也可能发生在 `res.json()` 那一句
 * （**响应头已经到了、body 还在流**）。后者原先会被归成 `upstream_invalid` → 路由回
 * `502 upstream_invalid`，而这一档的意思正是"模型契约不对"——一次上游停滞被丢进契约那一档，
 * 排查的人会去改提示词/模型，真凶却是连接卡住。
 *
 * 用 `signal?.` 而不是 `signal.`：信号缺失时这里不许多抛一种错误。
 */
const isTimeoutAbort = (err, signal) => signal?.aborted === true
  || err?.name === 'TimeoutError' || err?.name === 'AbortError';

/**
 * 调文本模型判一句话。
 *
 * @param {object} options
 *   - `sentence`：学习者写的原句（**原样发出去**，不 trim、不改写——见 `web/units/compose.mjs`）
 *   - `word`：这一轮的目标词；`scene`：这个词出现的场景（两者都由客户端带来）
 *   - `env`：`{ DEEPSEEK_API_KEY, DEEPSEEK_API_BASE, DEEPSEEK_MODEL }`（见 `server/env.mjs`）
 *   - `fetchImpl`：注入点，默认全局 `fetch`
 *   - `timeoutMs`：上游请求上限，默认 `UPSTREAM_TIMEOUT_MS`（必须小于客户端那条腿，见该常量）
 * @returns {Promise<{ feedback: object, usage: object|null, model: string|null }>}
 *   `feedback` 是模型给的 JSON 对象**原样**（本模块不做任何字段加工：多一个键少一个键都不补），
 *   语义是否可用由客户端的 `validateFeedback` 判
 * @throws {Error} `code === 'upstream_failed'`：网络错 / 非 2xx / **超时**（message 带状态码或"超时"）。
 *   超时含"响应头到了、body 还在流"时被上限中止的那一种
 * @throws {Error} `code === 'upstream_invalid'`：响应体不是 JSON（且**不是**被上限中止的）、
 *   `choices[0].message.content` 缺失或为空、content 不是 JSON、或解出来不是对象
 */
export async function feedbackUpstream({
  sentence, word, scene, env, fetchImpl = fetch, timeoutMs = UPSTREAM_TIMEOUT_MS,
}) {
  const body = {
    model: env.DEEPSEEK_MODEL,
    messages: [
      { role: 'system', content: FEEDBACK_PROMPT },
      {
        role: 'user',
        content: [
          `Target word: ${word}`,
          `Scene: ${scene}`,
          `Learner's sentence: ${sentence}`,
        ].join('\n'),
      },
    ],
    // JSON 模式兜底"必须是 JSON"（控制器 A4）：它保证**语法**，语义仍由客户端校验器把关。
    response_format: { type: 'json_object' },
    // 低温度：这一档要的是判定，不是发挥。
    temperature: 0.2,
  };

  const url = `${String(env.DEEPSEEK_API_BASE).replace(/\/+$/, '')}/chat/completions`;
  // 上限在这里装好（不放进 try）：参数非法要响亮地成为 TypeError，而不是被报成"上游失败"。
  const signal = AbortSignal.timeout(timeoutMs);

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // 超时也算上游失败，但消息必须说清是"超时"：它与"连不上"要能分开看
    // （`AbortSignal.timeout` 触发时 fetch 以 `TimeoutError` 拒绝，部分实现报 `AbortError`）。
    throw failed(isTimeoutAbort(err, signal)
      ? `上游请求超时（${timeoutMs}ms 未返回，已主动中止）：${String(err?.message ?? err)}`
      : `上游请求发不出去：${String(err?.message ?? err)}`);
  }

  if (!res.ok) {
    // 读一下 body 但**只留一小段**：诊断需要它，而整段可能很长且可能回显请求内容。
    let snippet = '';
    try { snippet = String(await res.text()).slice(0, 300); } catch { /* 读不到就算了 */ }
    throw failed(`上游返回 HTTP ${res.status}${snippet ? `：${snippet}` : ''}`);
  }

  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    // 与客户端那一腿同一分类：这个 catch 里有两种完全不同的成因——
    //   · **响应头到了、body 还在流时上限到点**（上游停滞）→ `upstream_failed` + 说清是超时；
    //   · 响应体真的不是 JSON → `upstream_invalid`（要改的是模型契约）。
    if (isTimeoutAbort(err, signal)) {
      throw failed(`上游请求超时（${timeoutMs}ms 未返回，已主动中止）：${String(err?.message ?? err)}`);
    }
    throw invalid(`上游响应不是合法 JSON：${String(err?.message ?? err)}`);
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw invalid('上游响应缺少 choices[0].message.content');
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    // `response_format: json_object` 只是兜底，不是保证：真出现非 JSON 内容时**如实失败**，
    // 绝不"从散文里抠出四个字段"当成功（那是猜测，不是判定）。
    throw invalid(`上游 content 不是合法 JSON：${String(err?.message ?? err)}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalid(`上游 content 解析出来不是对象：${JSON.stringify(parsed)?.slice(0, 120)}`);
  }

  return {
    // **原样**返回：不补默认值、不 trim、不重建对象（客户端拿到的就是模型原话的解）。
    feedback: parsed,
    // usage 原样带出（可能没有）。成本核算只认真实计数，不用估算。
    usage: payload.usage ?? null,
    model: payload.model ?? null,
  };
}
