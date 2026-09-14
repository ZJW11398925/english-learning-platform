/**
 * 造句反馈的响应校验（设计文档 §4.2）：**纯校验，不做网络调用**（网络路径在 Task 8 的
 * `compose.mjs`），零 import，可在 Node 里直接测。
 *
 * 它守的是「模型响应是不可信输入」这条线：模型可能少给字段、给出取值以外的判定、或把
 * `rewrite` 写成空白串。任何一项不合法都**整体判为不可用**（`{ ok: false, errors }`），由调用方
 * 落到 `feedback_pending` 队列——**绝不猜字段、不补默认值、不把失败静默降级成成功**（全局约束 3）。
 *
 * 三个判定档位 `correct | flawed | uncertain` 是**并列的合法结果**，`uncertain`（拿不准）不是错误：
 * 逼模型在"对/错"二选一，它在真拿不准时会编一个自信的错答案，那比缺数据更坏（全局约束 4）。
 * 因此 `uncertain` 走 `{ ok: true }`，由调用方单独统计、不计入通过率。
 *
 * 失败**返回结构而不是抛错**：这里的输入来自模型，字段不合规是**预期内的数据状况**，不是编程错误
 * （对比 Task 2 的 `frame-qc.mjs`：那里的输入由我们自己的代码产生，违约即 bug，所以抛错）。
 *
 * 几条约定：
 * - 返回值成功时是 `{ ok: true, value: raw }`——`value` **就是入参本身**，不 trim、不裁剪、不深拷贝：
 *   落库的记录必须是模型原话，校验器只当闸门，不当规整器。
 * - `errors` 是字符串数组，**每条都点名出错字段**（调用方在 Task 8 把它 `join('; ')` 成 `pending` 的
 *   诊断原因，不点名就没法定位），且**把所有字段都查完再返回**，不在第一条错误上短路。
 * - 四个字段之外的**多余键一律放行**：校验器的职责是"这四个字段能不能用"，不是封闭 schema；
 *   多余键随 `value` 原样入库，读它的地方只认这四个字段。
 * - 不做 JSON 解析：调用方把解析好的对象直接递进来。
 */

/** 判定档位（设计文档 §4.2）。冻结：档位是设计与统计口径写死的契约，调用方不得运行时改。 */
export const VERDICTS = Object.freeze(['correct', 'flawed', 'uncertain']);

/** 错误类型；`none` 表示无错（与 `correct`、`uncertain` 搭配）。冻结理由同上。 */
export const ERROR_TYPES = Object.freeze(['word_choice', 'collocation', 'grammar', 'none']);

/** 响应必须齐备的字段。缺一即不可用——少字段意味着模型没按强约束结构作答。 */
const REQUIRED_FIELDS = Object.freeze(['verdict', 'error_type', 'rewrite', 'note']);

/**
 * 校验模型返回的造句反馈。
 * @param {unknown} raw 解析后的响应对象（本函数不负责 JSON 解析）
 * @returns {{ ok: true, value: object } | { ok: false, errors: string[] }}
 */
export function validateFeedback(raw) {
  const errors = [];
  // 数组的 typeof 也是 'object'，必须显式拦掉：否则它会被当成"缺四个字段"的对象，
  // 报出一串指向错误原因的诊断（真正的问题是它根本不是响应对象）。
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['响应必须是对象'] };
  }
  for (const k of REQUIRED_FIELDS) {
    if (!(k in raw)) errors.push(`缺少字段 ${k}`);
  }
  const verdictInRange = 'verdict' in raw && VERDICTS.includes(raw.verdict);
  const errorTypeInRange = 'error_type' in raw && ERROR_TYPES.includes(raw.error_type);
  if ('verdict' in raw && !verdictInRange) {
    errors.push(`verdict 取值越界: ${String(raw.verdict)}`);
  }
  if ('error_type' in raw && !errorTypeInRange) {
    errors.push(`error_type 取值越界: ${String(raw.error_type)}`);
  }
  if ('rewrite' in raw && raw.rewrite !== null) {
    if (typeof raw.rewrite !== 'string' || raw.rewrite.trim() === '') {
      errors.push('rewrite 必须是非空字符串或 null');
    }
  }
  if ('note' in raw && (typeof raw.note !== 'string' || raw.note.trim() === '')) {
    errors.push('note 必须是非空字符串');
  }
  // 强制 verdict 与 error_type 的搭配关系。**只在两者各自合法时才判**：取值已越界时再补一句
  // "搭配错了"会把诊断带偏（真正的问题是取值不在枚举里），叠出来的第二条消息是误导而非信息。
  if (verdictInRange && errorTypeInRange) {
    if (raw.verdict === 'correct' && raw.error_type !== 'none') {
      errors.push('verdict=correct 时 error_type 必须是 none');
    }
    if (raw.verdict === 'flawed' && raw.error_type === 'none') {
      errors.push('verdict=flawed 时必须指出 error_type');
    }
  }
  return errors.length === 0 ? { ok: true, value: raw } : { ok: false, errors };
}
