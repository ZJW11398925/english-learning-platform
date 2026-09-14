// server/recognize-upstream.mjs
//
// 识物上游调用：把一帧 JPEG 发给视觉模型，取回**已校验**的候选词。
//
// 为什么单独一个模块（而不是全塞进 `server/index.mjs` 的路由里）：这一层承载的是
// **模型契约**（请求体形状、图片挂在哪儿、返回怎么校验），而契约是会被"改坏但测试全绿"的地方
// ——它必须能脱离 HTTP 单独测、单独变异（`scripts/mutation-probe.mjs` 的 `tests/recognize-upstream.test.mjs`
// 就是为此存在的）。路由层只剩"解析 multipart + 打状态码"。
//
// 密钥只在服务端（共享上下文全局约束 1）：本模块从 `env` 拿 Key，只往**上游**发；
// 返回值里绝不回带任何与密钥有关的字段，日志里也不打印它。
//
// 已核实的模型契约（2026-09-14，官方文档，见 shared-context「模型服务」一节）：
//   · `POST ${DEEPSEEK_API_BASE}/chat/completions`，OpenAI 格式，`Authorization: Bearer ${KEY}`
//   · 模型必须是 `${DEEPSEEK_MODEL}`（= `deepseek-flash`）；`deepseek-v4-pro` **不支持 Vision**
//   · 图片必须放在 **user** message 的 `content` 数组里；放进 system/assistant 会 400
//   · `detail` 用 `${VISION_DETAIL}`（默认 `low`：缩到 512×512，与设计文档 §4.6 的 512px 长边一致）
//   · base64 data URL 上限 32 MiB
//   · `response_format: { type: 'json_object' }` 兜底"必须返回严格 JSON"，但**仍须校验**

/** 上游返回的东西不是我们能用的形状时抛出的错误上挂的 `code`。 */
export const UPSTREAM_INVALID = 'upstream_invalid';
/** 上游调用本身失败（网络错、非 2xx、超时）时挂的 `code`——与"形状不对"分开报。 */
export const UPSTREAM_FAILED = 'upstream_failed';

/** data URL 上限 32 MiB（官方限制）。超过就没有必要发出去——早点响亮失败，省一次往返。 */
const MAX_DATA_URL_BYTES = 32 * 1024 * 1024;
/** 候选上限：设计文档 §4.1「三候选 + 人工重拍」。多出来的直接砍掉，不返回给客户端。 */
export const MAX_CANDIDATES = 3;

/**
 * 提示词：要求严格 JSON、按置信度排序、给场景标签。
 *
 * `label` 用**具体名词**（`mug` 而不是 `container`）是有意的：`pickWord` 只认预声明的可接受集，
 * 上位词对"学一个能指着说的具体名词"毫无价值（见 `web/units/pick-word.mjs` 的说明）。
 * 提示词只能"劝"，判定权仍在 `pickWord`——这里不引入任何判定逻辑。
 */
export const RECOGNIZE_PROMPT = [
  'Look at the photo and identify the single main object the user is pointing at.',
  'Return STRICT JSON only, no prose, in exactly this shape:',
  '{"candidates":[{"label":"mug","score":0.9,"scene":"kitchen"}]}',
  'Rules:',
  '- 1 to 3 candidates, ordered by confidence, most likely first.',
  '- "label": ONE lowercase English concrete noun, singular, of the physical object itself',
  '  (e.g. "mug", "kettle", "book"). NEVER a hypernym or category word such as',
  '  "container", "vessel", "object", "thing", "item".',
  '- "score": a number between 0 and 1.',
  '- "scene": one short lowercase English word for where the object is (e.g. "kitchen", "desk", "street").',
  '- If you cannot identify any object, return {"candidates":[]}.',
].join('\n');

/** 一条候选的形状：`label` 必须是非空字符串；`score` 有限数或 null；`scene` 字符串或 null。 */
function normalizeCandidate(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  if (label === '') return null;
  const score = Number.isFinite(raw.score) ? raw.score : null;
  const scene = typeof raw.scene === 'string' && raw.scene.trim() !== '' ? raw.scene.trim() : null;
  return { label, score, scene };
}

/**
 * 调用视觉模型识别一帧。
 *
 * @param {object} options
 *   - `image`: Buffer/Uint8Array，一帧 JPEG 的**原始字节**（不是 base64）
 *   - `mime`: 该帧的 MIME（默认 `image/jpeg`）
 *   - `env`: `{ DEEPSEEK_API_KEY, DEEPSEEK_API_BASE, DEEPSEEK_MODEL, VISION_DETAIL }`（见 `server/env.mjs`）
 *   - `fetchImpl`: 注入点，默认全局 `fetch`
 * @returns {Promise<{ candidates: Array<{label: string, score: number|null, scene: string|null}> }>}
 *   候选已校验、已截到 `MAX_CANDIDATES` 条；`score`/`scene` 缺失时为 `null`（**不编造**）
 * @throws {Error} `code === 'upstream_failed'`：网络错 / 非 2xx（message 带状态码）
 * @throws {Error} `code === 'upstream_invalid'`：非 JSON 响应体、choices 结构不对、
 *   `candidates` 不是数组、或数组里有**任何一条**连 `label` 都给不出来
 */
export async function recognizeUpstream({ image, mime = 'image/jpeg', env, fetchImpl = fetch }) {
  const bytes = Buffer.isBuffer(image) ? image : Buffer.from(image);
  const body = {
    model: env.DEEPSEEK_MODEL,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: RECOGNIZE_PROMPT },
        {
          type: 'image_url',
          // 图片**必须**在这一层（user message 的 content 数组）里。放进 system/assistant 会 400。
          image_url: { url: `data:${mime};base64,${bytes.toString('base64')}`, detail: env.VISION_DETAIL },
        },
      ],
    }],
    response_format: { type: 'json_object' },
    // 低温度：这一档要的是"看清是什么"，不是发挥。
    temperature: 0.1,
  };

  const dataUrlBytes = body.messages[0].content[1].image_url.url.length;
  if (dataUrlBytes > MAX_DATA_URL_BYTES) {
    const err = new Error(`图片过大：data URL ${dataUrlBytes} 字节，超过上限 ${MAX_DATA_URL_BYTES}`);
    err.code = UPSTREAM_INVALID;
    throw err;
  }

  const url = `${String(env.DEEPSEEK_API_BASE).replace(/\/+$/, '')}/chat/completions`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const wrapped = new Error(`上游请求发不出去：${String(err?.message ?? err)}`);
    wrapped.code = UPSTREAM_FAILED;
    throw wrapped;
  }

  if (!res.ok) {
    // 读一下 body 但**只留一小段**：诊断需要它，而整段可能很长且可能回显请求内容。
    let snippet = '';
    try { snippet = String(await res.text()).slice(0, 300); } catch { /* 读不到就算了 */ }
    const err = new Error(`上游返回 HTTP ${res.status}${snippet ? `：${snippet}` : ''}`);
    err.code = UPSTREAM_FAILED;
    throw err;
  }

  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    const wrapped = new Error(`上游响应不是合法 JSON：${String(err?.message ?? err)}`);
    wrapped.code = UPSTREAM_INVALID;
    throw wrapped;
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    const err = new Error('上游响应缺少 choices[0].message.content');
    err.code = UPSTREAM_INVALID;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    // `response_format: json_object` 只是兜底，不是保证：真出现非 JSON 内容时**如实失败**，
    // 绝不"从文本里抠一个词"当成功（那是猜测，不是识别）。
    const wrapped = new Error(`上游 content 不是合法 JSON：${String(err?.message ?? err)}`);
    wrapped.code = UPSTREAM_INVALID;
    throw wrapped;
  }

  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.candidates)) {
    const err = new Error('上游 JSON 缺少 candidates 数组');
    err.code = UPSTREAM_INVALID;
    throw err;
  }

  // 逐条校验：**任意一条**连 label 都给不出来就整份判非法。宁可如实报"上游无效"，
  // 也不静默剔掉坏条目——后者会把"模型吐了垃圾"伪装成"模型很确定地给了这几条"。
  const normalized = [];
  for (const raw of parsed.candidates) {
    const c = normalizeCandidate(raw);
    if (c === null) {
      const err = new Error(`上游候选项缺少可用的 label：${JSON.stringify(raw)?.slice(0, 120)}`);
      err.code = UPSTREAM_INVALID;
      throw err;
    }
    normalized.push(c);
  }

  return {
    candidates: normalized.slice(0, MAX_CANDIDATES),
    // usage 原样带出（可能没有）。成本核算只认真实计数，不用估算——见 shared-context「仍然未知」。
    usage: payload.usage ?? null,
    model: payload.model ?? null,
  };
}
