// web/units/deepseek.mjs
//
// Task 12A（项目转向 DEC-…23/26）：识物与造句两条链路都从「本机服务端代理」改为
// **浏览器直连** `https://api.deepseek.com`。直连地址、模型名、视觉细节档、以及上游响应信封
// （`choices[0].message.content`）的解析，是两条链路**共用**的契约——收在这里，免得两条链路
// 各自拼 URL、各自拆信封，将来一边改了另一边不知道。
//
// 与被退役的旧服务端代理两个上游单元的关系（原文件已随退役删除，见 git 历史）：
// 这两个服务端模块在 Task 12A **原样保留**（12C 才删），客户端这边把它们的模型契约**移植**
// 过来。移植口径由 parity 用例钉住（tests/deepseek.test.mjs：提示词逐字一致、截断常量一致），
// server 退役之前两边不许漂移。
//
// 纯逻辑模块：零 import、零浏览器 API、常量与纯函数各就各位——可在 Node 里直接测、
// 直接变异（scripts/mutation-probe.mjs 的 D 系列）。

/**
 * 直连 base（带 `/v1`）。转向契约（Task 12 计划）写死的地址：浏览器直接 POST 到
 * `${DEEPSEEK_API_BASE}/chat/completions`。CORS 已实测放行（DEC-…26 的三项形态依据之一）。
 */
export const DEEPSEEK_API_BASE = 'https://api.deepseek.com/v1';

/**
 * 模型名（与 `.env.example` 的 `DEEPSEEK_MODEL` 同源）。识物这条腿必须用它：
 * `deepseek-v4-pro` **不支持 Vision**（契约记录见 git 历史中被退役的服务端上游单元）。
 */
export const DEEPSEEK_MODEL = 'deepseek-flash';

/**
 * 识物图像细节档（原 server 端 `VISION_DETAIL` 的缺省值）：`low` 缩到 512×512，
 * 与端侧帧的 512px 长边（设计文档 §4.6）一致——端侧已经缩过一次，再要 high 是白花钱。
 */
export const VISION_DETAIL = 'low';

/**
 * 拼 chat/completions 的完整 URL。base 末尾的斜杠一律剥掉（调用方注入自定义 base——
 * 测试桩、或将来的替代网关——时不产生 `//chat/completions` 这种地址）。
 */
export function chatUrl(apiBase = DEEPSEEK_API_BASE) {
  return `${String(apiBase).replace(/\/+$/, '')}/chat/completions`;
}

/**
 * 从上游响应里取出 `choices[0].message.content`。
 *
 * 返回字符串，或信封不合法时 `null`——"不合法"统一表达成 null，**分档归各链路自己**
 * （识物侧落 `response_invalid`，造句侧落 `feedback_pending{reason:'response_invalid'}`）：
 * 两个链路对"信封不对"的处置形状不同，这里只负责"有没有一个能用的 content"。
 * 原服务端同位置的校验口径原样搬来：必须是**非空白字符串**，其余（数字、空数组、缺键）都算不合法。
 */
export function extractContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  return typeof content === 'string' && content.trim() !== '' ? content : null;
}
