// server/redact.mjs
//
// 一件事：**把明显的密钥形状从一段文本里抹掉**。给两条上游腿（识物 / 造句）共用。
//
// 为什么需要它（Task 8 复审 Item 1）：两条上游腿在非 2xx 时会把响应体的**前 300 字**
// 拼进 `Error.message`，而路由层把这条 message 写进服务端 stderr（`server/index.mjs` 的
// `feedback 失败（…）` / `recognize 失败（…）` 两行）。上游若在 401/500 的正文里**回显请求**
// （把 `Authorization: Bearer …` 或密钥本身抄回来），那段文字就会原样落进日志——而清单与报告里
// 写的是"日志里绝不出现密钥"。同理，Node 的 `JSON.parse` 报错消息会带上输入的**前 ~10 个字符**
// （实测：`Unexpected token 's', "sk-abcdefg"... is not valid JSON`），所以"200 但正文不是 JSON"
// 那条消息也要过这里。
//
// **整段删掉是不可接受的**：出故障时运维要看的正是"上游到底说了什么"——抹密钥是为了让
// 这段证据**可以照旧留着**，不是为了把它删掉。
//
// ── 抹掉什么（穷举；别把这条读成"洗白了"）────────────────────────────────────
//   1. `Bearer <token>`（不分大小写）→ `Bearer [已抹去]`
//   2. `sk-…` 形状的串（DeepSeek 密钥的前缀）→ `sk-[已抹去]`
//   3. 常见密钥字段名后面跟的值（引号可有可无）：
//      `"api_key": "…"` / `api-key=…` / `authorization: …` / `token` / `secret` /
//      `password` / `credential`（含 access/auth/refresh token 三种写法）→ 值换成 `[已抹去]`
//
// ── **没有**抹掉什么（如实说清，免得把这个模块当成保证）──────────────────────
//   · 我们**没枚举到**的凭据形状：JWT、裸 hex、被拆开/重排/编码过的正文；
//   · 上游正文里**非密钥**的内容——状态码、`error`、`message`、`request_id` 照旧留着，
//     那正是诊断要看的东西；
//   · 学习者原句与目标词：它们**本来就要进日志**（验证三的语料采集口，见 `server/index.mjs`），
//     不在本模块的职责里。
//
// 结论：这是一道**减少暴露面**的过滤，不是"日志里保证没有机密"的证明——任何声称后者的话
// 都比这个模块能担保的更强。真正的不变式只有一条：**经过这里的文本里，上面三类形状不再出现。**
//
// 纯函数、零依赖：可以脱离 HTTP 单独测（`tests/feedback-endpoint.test.mjs` 有直接用例），
// 也被 `scripts/mutation-probe.mjs` 复制进临时树（`MODULE_FILES.redact`）。

/** 抹掉之后留下的占位符。看得见"这里原本有东西"，但看不出是什么。 */
const MASK = '[已抹去]';

/**
 * 抹除规则，**按顺序**应用（顺序有理由）：**先按字段名抹值，再抹裸的凭据形状**。
 *   · 字段名那条能把 `"authorization":"Bearer sk-xxx"` 整个值（含引号）一次吃掉，
 *     抹完是 `"authorization":[已抹去]`——JSON 结构还在，最好读；
 *   · 反过来的话，`Bearer …` 会先把值改成 `Bearer [已抹去]`，字段名那条再啃一口，
 *     结果虽然同样安全，却会抹成 `[已抹去] [已抹去]`（读日志的人要猜两段是什么）。
 * 每条都是全局替换（一段正文里可能出现多次）。
 */
const RULES = [
  // 1. 密钥字段名后面的值：`"api_key": "…"`、`api-key=…`、`authorization: …`。
  //    值可以是带引号的串（含空串——引号一起吃掉，结构仍在）或一段不带空白的裸串；
  //    裸串那条 `[^\s,;&"'\]}]+` 遇到分隔符（空格 / 逗号 / 引号 / 花括号）就停，不会吃掉整段正文。
  [
    /((?:"|')?(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|authorization|secret|password|passwd|credential|token)(?:"|')?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&"'\]}]+)/gi,
    `$1${MASK}`,
  ],
  // 2. Authorization 头最常见的写法：`Bearer <token>`（也可能出现在正文的任意位置、没有字段名）
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${MASK}`],
  // 3. 厂商密钥前缀：`sk-` 后面跟一串 base64url/hex（DeepSeek 的密钥就是这个形状）
  [/\bsk-[A-Za-z0-9_-]{3,}/g, `sk-${MASK}`],
];

/**
 * 把 `text` 里明显是密钥的形状抹掉，其余一字不动。
 *
 * @param {unknown} text 任意文本（`null` / `undefined` 一律当空串处理，不抛错——
 *   它会被用在错误消息的拼接处，那里多抛一种错误是把故障复杂化）
 * @returns {string}
 */
export function redactSecrets(text) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}
