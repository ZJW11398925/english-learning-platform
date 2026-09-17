// web/units/teach/profile.mjs
//
// 学习者画象：跨会话记住"用过哪些方法、反复错在哪、当前难度档"（设计稿 §10 数据模型草案）。
//
// **纯逻辑：零浏览器 API、零副作用**（storage 由调用方注入，与 `units/keyring.mjs` / `units/store.mjs`
// 同一种做法，便于在 Node 里用假存储测）。只 import 两个同目录纯模块：
// `./difficulty.mjs`（合法档位集合的权威）与 `./method.mjs`（合法方法名的权威）。
//
// ---------------------------------------------------------------------------
// 为什么**必须**持久化方法使用记录
// ---------------------------------------------------------------------------
// 设计稿 §2.3 的"不审讯"由 `method.mjs` 的"连续两次同法即换挡"实现，而"连续两次"需要**跨会话**的
// 历史——会话内记住没用，下次打开又从零开始，用户就会再次被同样的方式问一遍。设计稿 §10 把这条
// 写成关键约束：「**方法使用记录必须持久化**——否则"连续 2 次同方法就换挡"无法实现」。
// 所以防审讯的有效性**依赖这份记录**，而不是依赖提示词自觉。
//
// ---------------------------------------------------------------------------
// 两条边界纪律的分野（本模块的全部难点都在这里）
// ---------------------------------------------------------------------------
// 同一份数据上要同时成立两件事，而它们看起来是对立的：
//
//   A. **数据坏了 → 安全回退**（读路径）。存储里的画象读不出来、字段类型不对、档位越界
//      ⇒ 退回干净画象，**不抛错**。理由是这份数据已经在盘上了（旧版本写的、或别人手改的），
//      此刻抛错等于把学习者锁在对话外面——一份坏画象不该让整个应用打不开。与 `store.mjs`
//      对坏数据的口径一致。
//      ⚠️ **档位回退必须按"合法档位集合"判，不是按"是不是整数"判**（计划的 `Number.isInteger`
//      只查类型不查范围）：存储里一条 `{"band":9}` 会让 `band()` 返回 9 → Task 10 交给
//      `runTurn` → `assemblePrompt` 在**循环的 try 之外**抛 TypeError → 视图的 async 回调 reject
//      ⇒ **学习者发完消息永远等不到回复**。这不是"难度不对"，是整轮不动。
//      合法集合的权威是 `difficulty.mjs` 的 `BANDS`，本模块不抄第二份。
//
//   B. **契约被违反 → 响亮抛错**（写路径）。缺 storage、非法档位、未知方法名 ⇒ TypeError。
//      这些是**程序 bug**（入参只来自引擎自己），静默兜底会给出一个"看起来正常"的答案，
//      比抛错坏得多（同族：`teach/session.mjs` 的 `send('toString')` 曾静默改坏状态；
//      `teach/method.mjs` 的 `history:'guess'` 会被逐字符索引）。
//      ⚠️ **读取路径的安全回退不是放宽写入路径的理由**：`setBand(9)` 照抛不误。
//
// 两处**刻意的不对称**（写严读宽），都已如实测过：
//   · 未知方法名：`recordMethod('bogus')` 抛 TypeError，而存储里已有 'bogus' 时**静默丢掉**
//     （旧数据不该把学习者锁在外面；且 `chooseMethod` 只会把它当"没用过 MVP 方法"，
//     不会返回它）。丢掉是为了让 `methodsUsed()` 的返回面**恒为已知方法名**，一个可断言的不变量。
//   · 合法档位：`setBand(9)` 抛，而存储里的 9 **回退成 2**。
//
// ---------------------------------------------------------------------------
// 接口面就是六个方法（计划声明的 `read()` 与 `recordFocus()` **不存在**，且不该补）
// ---------------------------------------------------------------------------
// 计划 `plan:1272` 的 Interfaces 声明是
// `{ read(), recordMethod(m), recordFocus(ref), recordError(pattern), setBand(b), methodsUsed(), errorPatterns(), band() }`，
// 而它自己的实现（`plan:1410-1426`）**既没有 `read()` 也没有 `recordFocus(ref)`**——声明与实现不符。
// 本模块按**实现**交付六个，并写清为什么那三个不该有：
//   · `read()` —— **不需要**。`methodsUsed()` / `errorPatterns()` / `band()` 就是读接口，分开命名
//     比一个 `read()` 更可读：调用方拿到的是各自需要的那个字段，而不是一整份内部记录
//     （一整份记录会把存储的**存储形状**泄漏成公开契约——形状一改，所有调用方跟着改）。
//   · `recordFocus(ref)` —— **在 MVP 里没有任何消费方**。全计划里唯一读焦点状态的地方是
//     Task 10 拼第六个提示词槽「学习者状态」，而它在那里是**硬编码 `'untouched'`**（`plan:1813`），
//     且 `focus.mjs:46` 的 `status` 恒为 `FOCUS_STATUS[0]`。⇒ 补一个没有消费方的写接口 = 凭空发明
//     一套"焦点状态怎么推进"的语义（那是教学判断，本轮没有真实数据支撑）。**登记不改**。
//   · **连带登记的事实**：因为没有任何地方记录焦点状态，**「学习者状态」这个提示词槽在整个 MVP 里
//     恒为 `'untouched'`**。理由与重估条件见决策 `DEC-OPI-968b804d-af33-437d-be9b-277ecead51db.96`。
//     写在这里是为了一句判据：**"接口文档里写了" ≠ "它在跑"**。
//     测试 `tests/teach-profile.test.mjs` 的导出面用例把"恰好六个"钉住了——将来有人照着假声明
//     补上 `read()` / `recordFocus()`，那个用例会红，他会被迫先读这段。
//
// ---------------------------------------------------------------------------
// 代价（如实记，别含糊过去）
// ---------------------------------------------------------------------------
//   ① **写失败是静默的，而它的后果是「防审讯」会静默失效。** `write()` 吞掉存储异常
//      （`setItem` 抛 QuotaExceededError / 隐私模式下抛 SecurityError）——这个取舍是**有意的**：
//      另一半是"整个学习流程因为写不进去而中断"，那更坏。
//      但后果必须写明：**`recordMethod` 写失败 ⇒ 方法历史不推进 ⇒ `chooseMethod` 拿到旧历史
//      ⇒ 它会重复问同一种方法 ⇒「不审讯」失效，而没有任何症状**（学习者会一直遇到同一个问法，
//      界面上、日志里、测试里都看不出来）。同理 `setBand` 写失败 = 档位不生效但不报错。
//      **这不是"已处理"，是"已接受"**——测试里有一条用例把这个代价**锁成契约**
//      （写失败不抛错 + 历史确实没推进），使"改成抛错"或"假装推进了"都会红。
//      ⚠️ **未在真实浏览器验证**：配额满时 `setItem` 到底抛什么（QuotaExceededError 的形态
//      各家不一、Safari 隐私模式另有一套），本模块只用注入的假存储测过"抛 ⇒ 被吞掉"。
//   ② **仍然没有账号**：这份画象只在本机浏览器里（由调用方注入的那个 storage）。清一次浏览器数据
//      即清空全部积累——已登记为契约 COST/PRIVACY 风险 3（设计稿 §11 风险 3）。
//   ③ **只存最近 6 次方法与最近 8 条错误模式**。更长的历史对"防审讯"没有增量价值
//      （判据只看"最近用过的是什么"），而无限增长会让存储成为负担。6 与 8 是**设计判断**，
//      不是实测结论——钉住它们的是测试里的逐字断言（"最近 6 个""最近 8 条"），
//      钉住的是"别无声改掉"，不是"这两个数是对的"。
//   ④ **不记焦点状态、不记"已能用/认得的词"、不记偏好**：设计稿 §10 的画象草案里还有这三样，
//      计划只切了方法/错误/档位三样。这是计划的 MVP 范围切分，如实登记为缺口，不偷偷补。
//      没有它们的具体后果：§3.5.2 的"起点靠第一次对话推断"与 §3.5.4 的难度自适应在当前接线
//      **都不运行**（`band` 恒为 2，`stepUp` / `setBand` 零生产调用点，见 `DEC-…db.96`）。
//   ⑤ **本模块不认识教学效果**。它能保证"记下来了、坏数据不传下去"，保证不了
//      "这次选的方法对这个焦点合适"——后者需要真实使用观察（HUMAN_EVALUATION），纯函数测不了。

import { BANDS } from './difficulty.mjs';
import { ALL_METHODS, METHOD_LABELS } from './method.mjs';

/** 存储键（与旧形态的 elp.apiKey / elp.words / elp.events 并列，互不覆盖）。 */
export const PROFILE_KEY = 'elp.teach.profile';

/** 最多记多少次方法使用（判据只看"最近用过什么"，见文件头代价 ③）。 */
const MAX_METHOD_HISTORY = 6;

/** 最多记多少条错误模式。 */
const MAX_ERROR_PATTERNS = 8;

/**
 * 没有依据时的难度档。
 *
 * 计划定的是 2，人裁决**维持 2**（`DEC-OPI-968b804d-…db.103`），理由：§3.5.1 的四档是**能力描述**，
 * 2 = "能说完整简单句"，而把这类人放到"只会单词短句"的 1 档**不是"稍微简单"而是错档**；
 * §3.5.2 的"宁可定低一档"是**相对指令**（从你的估计再降一档），不是"取最低档"。
 * ⚠️ 但如实登记一条不对称：最需要下调的真初学者在 MVP 里**没有下调通道**（`band` 恒为 2、
 * `setBand` 零生产调用点，见 `DEC-…db.96`）。
 */
const DEFAULT_BAND = 2;

/** 干净的画象（坏数据与空存储都退回它）。 */
const emptyProfile = () => ({ methods: [], errors: [], band: DEFAULT_BAND });

/**
 * storage 守卫：**契约被违反就响亮抛错**（与 `teach/method.mjs` / `teach/difficulty.mjs` 同口径）。
 *
 * `getItem` 与 `setItem` **两个都要查**。少了这条守卫、或只查其中一个，后果都是静默的：
 *   · 完全不查 ⇒ `recordMethod` 里 `storage.getItem(...)` 抛 "Cannot read properties of undefined"，
 *     或者更坏——`write` 的 `catch` 把 `setItem is not a function` 吞掉，于是**画象看起来能用、
 *     永远读回空**（防审讯静默失效，一条错误都不报）。
 *   · 只查 `getItem` ⇒ 正是上一句那个"看起来能用、永远读回空"。
 */
function assertStorage(storage) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    throw new TypeError('createProfile: storage 必须提供 getItem/setItem（缺了会让防审讯静默失效）');
  }
}

/**
 * 合法档位的判据：**必须是 `difficulty.mjs` 的 `BANDS` 里的一员**（不是"是不是整数"）。
 *
 * `BANDS.includes` 走 SameValueZero 严格相等，所以它同时挡掉非整数、字符串 `'3'`、
 * `NaN`、`null`——比"整数 + 手抄一组上下界"更严也更少一个出处。见文件头 A 段。
 */
function isLegalBand(v) {
  return BANDS.includes(v);
}

/**
 * 造一份学习者画象（读写都走注入的 storage）。
 *
 * @param {{ storage: { getItem: Function, setItem: Function } }} deps
 * @returns {{ methodsUsed(): string[], errorPatterns(): string[], band(): number,
 *             setBand(band: number): void, recordMethod(method: string): void, recordError(pattern: string): void }}
 * @throws {TypeError} 缺 storage / storage 不提供 getItem+setItem
 */
export function createProfile({ storage } = {}) {
  assertStorage(storage);

  /** 读盘 → 逐字段回退（**读路径：坏数据安全回退，不抛错**）。 */
  const readRaw = () => {
    try {
      const raw = storage.getItem(PROFILE_KEY);
      if (raw === null || raw === undefined || raw === '') return emptyProfile();
      const parsed = JSON.parse(raw);
      return {
        // 只留已知方法名（写路径已经保证新写入的合法；这里挡的是**已经在盘上的**旧数据）。
        methods: Array.isArray(parsed?.methods)
          ? parsed.methods.filter((m) => typeof m === 'string' && ALL_METHODS.includes(m))
          : [],
        errors: Array.isArray(parsed?.errors) ? parsed.errors.filter((e) => typeof e === 'string') : [],
        // 档位按**合法集合**回退（不是"是不是整数"）：`{"band":9}` 原样传下去会让
        // `assemblePrompt` 抛在循环之外 ⇒ 学习者永远等不到回复。见文件头 A 段。
        band: isLegalBand(parsed?.band) ? parsed.band : DEFAULT_BAND,
      };
    } catch {
      return emptyProfile();   // 坏数据（含 getItem 自己抛）静默退回干净画象
    }
  };

  /**
   * 落盘。**故意不抛错**——不该让学习流程因为写不进去而中断。
   * ⚠️ 代价写在文件头代价 ①：写失败 ⇒ 历史不推进 ⇒ 防审讯静默退化。
   */
  const write = (data) => {
    try {
      storage.setItem(PROFILE_KEY, JSON.stringify(data));
    } catch {
      // 存储满了 / 隐私模式：不抛错，代价是这一次没记住（见文件头代价 ①）
    }
  };

  return {
    methodsUsed() { return readRaw().methods; },
    errorPatterns() { return readRaw().errors; },
    band() { return readRaw().band; },

    /**
     * 写档位。**写路径响亮抛错**（与读路径的回退故意不对称，见文件头 B 段）。
     * @throws {TypeError} 不是合法档位
     */
    setBand(band) {
      if (!isLegalBand(band)) {
        throw new TypeError(`setBand: 难度档必须是 ${BANDS.join(' / ')} 之一，收到 ${JSON.stringify(band) ?? String(band)}`);
      }
      write({ ...readRaw(), band });
    },

    /**
     * 记一次方法使用——**防审讯的前提**（`chooseMethod` 的 history 就是这里读出来的）。
     *
     * 只收 `method.mjs` 认识的九种方法名（`METHOD_LABELS` 是权威）：未知名字是**引擎自己的 bug**
     * （唯一调用点 `plan:1809` 是 `recordMethod(chooseMethod({...}))`，而 `chooseMethod` 的返回值
     * 恒为 MVP 四法之一），静默丢弃会把一个真 bug 变成看不见的行为差异。见文件头 B 段。
     *
     * 用 `Object.hasOwn` 而不是 `METHOD_LABELS[m] !== undefined`：后者会顺着原型链取到
     * `toString` / `constructor` / `__proto__` / `hasOwnProperty`，于是 `recordMethod('toString')`
     * 通过校验，而 `readRaw` 的 filter 又会把它丢掉——写入成功、读回没有，最难查的那种。
     *
     * @throws {TypeError} 未知方法名 / 非字符串
     */
    recordMethod(method) {
      if (typeof method !== 'string' || !Object.hasOwn(METHOD_LABELS, method)) {
        throw new TypeError(
          `recordMethod: 不认识的方法 ${JSON.stringify(method) ?? String(method)}；已知：${ALL_METHODS.join(' / ')}`,
        );
      }
      const d = readRaw();
      write({ ...d, methods: [...d.methods, method].slice(-MAX_METHOD_HISTORY) });
    },

    /** 记一条反复出错的结构（同一条不记两次；只留最近 N 条）。 */
    recordError(pattern) {
      const d = readRaw();
      const key = String(pattern);
      if (d.errors.includes(key)) return;
      write({ ...d, errors: [...d.errors, key].slice(-MAX_ERROR_PATTERNS) });
    },
  };
}
