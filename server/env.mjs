// server/env.mjs
//
// 环境变量校验：启动即失败，不静默降级成"没有密钥也能跑"。
//
// 本函数**只读传入的 source 对象**（缺省 process.env），绝不读文件——`.env` 由
// Node 运行时用 `--env-file=.env` 载入，不在这里解析。这样它保持可注入、可单测。

const REQUIRED = ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_BASE', 'DEEPSEEK_MODEL'];
const OPTIONAL_DEFAULTS = { VISION_DETAIL: 'low' };

/** 本服务的正确启动方式。写进报错信息，好让读者分清"密钥没填"和".env 没加载"。 */
export const START_COMMAND = 'node --env-file=.env server/index.mjs';

/** 缺失判定：undefined 与空字符串（含纯空白）同等对待，防 `.env` 里留空键。 */
const isBlank = (v) => v === undefined || String(v).trim() === '';

export function loadEnv(source = process.env) {
  const missing = REQUIRED.filter((k) => isBlank(source[k]));
  if (missing.length > 0) {
    throw new Error(
      `缺少必需的环境变量: ${missing.join(', ')}（见 .env.example）\n`
      + `启动方式: ${START_COMMAND}（.env 由 Node 运行时加载，不是由本程序解析）`,
    );
  }
  const env = {};
  for (const k of REQUIRED) env[k] = String(source[k]);
  for (const [k, fallback] of Object.entries(OPTIONAL_DEFAULTS)) {
    env[k] = isBlank(source[k]) ? fallback : String(source[k]);
  }
  env.PORT = Number(source.PORT ?? 8787);
  if (!Number.isInteger(env.PORT) || env.PORT <= 0) {
    throw new Error(`PORT 非法: ${String(source.PORT)}`);
  }
  return env;
}
