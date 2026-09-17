// web/units/teach/difficulty.mjs
//
// 难度四档（设计稿 §3.5）。**纯逻辑：零 import、零浏览器 API、零副作用。**
//
// 为什么需要"静态起点"：§3.3 的换挡是**动态**调节（根据信号换方法），但同一个"犹豫"，
// 入门和熟练该用完全不同教法。缺了静态档位，系统会对所有人都用同一种难度。
//
// 三条设计选择（都是有意的，不是默认值）：
//   1. **不引入 CEFR 术语**（A1/B2…）：学习者不需要知道自己是"B1"，那是考试语汇。
//   2. **宁可定低一档**：低一档只是稍微简单，高一档直接挫败——**挫败的代价远大于无聊**。
//      所以 stepDown 比 stepUp 更容易被触发（由 loop 决定，本模块只提供动作）。
//   3. **用行为表现难度，不用数字**：升档表现为"台子变难、帮助变少"，界面上**不显示进度条**。
//      这与 NON_GOALS"不制造分数焦虑"一致。
//
// 每档为什么是这几个数（四档的能力画像见设计稿 §3.5.1）：
//   1 入门（会说单词和短句）：上限收到 **60 字符**——只够 1-2 句短句。首字母提示与示例句
//     **都给**，因为此刻缺的是"想不起那个词"，不是"不会组织"。帮助步数留 3 —— 台子最低。
//   2 基础（能说完整简单句，时态时对时错）：上限 **120**（约 2 句）。首字母仍给（拼写仍是主要
//     障碍），**示例句撤掉**——再给整句就等于替他说了，而 §3.5.3 的 2 档要的是"他卡住再给释义"。
//   3 进阶（能连成段，搭配常错）：上限 **200**。首字母也撤——此时"想不起拼写"已不是主要障碍，
//     给了反而把他的注意力从"用不用得上"拉回"拼得对不对"。帮助降到 2 步：要的是搭配与从句。
//   4 熟练（要的是地道、精炼、风格）：上限放到 **320**，因为对他的约束不再是"别啰嗦"而是
//     "别写成教科书"；给整段空间才谈得上语域。两种直手帮助**全撤**（§3.5.3 的 4 档"不告诉他要
//     学什么词"），帮助步数只留 1 —— 逼一次就该换方法，不是继续喂。
//
// 代价（如实记）：
//   ① `maxChars` 是**字数上限**，不是 token 数——中英混排下它只是个粗略尺子。它够用是因为它的
//      职责是"拦住模型的长篇大论"，而不是精确控制长度。
//   ② `minHelpSteps` 的取值（3 / 2 / 2 / 1）是**设计判断，不是实测结论**。计划自带的 7 条用例
//      **一条都没断言它**（`git grep minHelpSteps` 在计划里 6 处、在当时的 web/ 与 tests/ 里 0 处；
//      下游 Task 5 只把它拼进一句提示词文本，也没断言）——它原本是一处**零保护的自由度**。
//      复核轮补的护栏把整张参数表 deepEqual 钉住了，所以"无声改掉它"现在会弄红用例；
//      但**钉住 ≠ 这个值是对的**：它仍然只是一处未经使用验证的设计判断，此处不冒充实测结论。
//   ③ 本模块不认识教学效果。它能保证"参数按档位单调",保证不了"这一档对这个学习者真的合适"——
//      后者需要真实使用观察（HUMAN_EVALUATION），纯函数测不了。§3.5.2 的"起点靠第一次对话推断"
//      也不在本模块内，本模块只提供档位与动作。

/** 四档（升序）。设计稿 §3.5.1，刻意不用 CEFR 术语。 */
export const BANDS = Object.freeze([1, 2, 3, 4]);

/** 档位中文名（界面上要说人话）。 */
export const BAND_LABELS = Object.freeze({ 1: '入门', 2: '基础', 3: '进阶', 4: '熟练' });

/** 每档的行为参数。上限单位是字符（中英混排的粗略尺子，见文件头"代价"）。 */
const RULES = Object.freeze({
  1: Object.freeze({ maxChars: 60, allowFirstLetterHint: true, allowSampleSentence: true, minHelpSteps: 3 }),
  2: Object.freeze({ maxChars: 120, allowFirstLetterHint: true, allowSampleSentence: false, minHelpSteps: 2 }),
  3: Object.freeze({ maxChars: 200, allowFirstLetterHint: false, allowSampleSentence: false, minHelpSteps: 2 }),
  4: Object.freeze({ maxChars: 320, allowFirstLetterHint: false, allowSampleSentence: false, minHelpSteps: 1 }),
});

/**
 * 档位守卫：**契约被违反就响亮抛错**（与 `teach/method.mjs` 同口径）。
 *
 * 守卫整条**在不在**是硬契约。少了它的后果都是"静默给出一个看起来合法的答案"：
 * `bandRules(0)` 返回 `undefined`，下游 `bandRules(0).maxChars` 抛的是"读不到属性"这种
 * **指错方向的**错误；`stepUp(2.5)` 走到 `BANDS.indexOf(2.5) === -1` ⇒ `Math.min(0, 3)` ⇒
 * **静默返回第 1 档**；`stepDown(0)` 同理静默返回 1。与 `teach/method.mjs` 已修的
 * `chooseMethod({history:'guess'})`（`'guess'[4]` 被当成方法名）是同一族。
 *
 * 至于 `if` 里那两个条件句：**`!Number.isInteger(band)` 被 `!BANDS.includes(band)` 完全蕴含**
 * ——`BANDS` 全是整数，而 `includes` 走 SameValueZero 严格相等，能通过枚举检查的值必是整数。
 * 所以在今天的 `BANDS` 下**删掉整数判断不改变任何输入下的行为，也没有测试能区分这两版**
 * （变异实测：计划 7 条 + 护栏全绿；两版对 29 个输入 × 3 个导出函数 = 87 组差分扫描，0 差异，
 * 见 `tmp/probes/task-4-assert-guard-equivalence-check.mjs` 与 Task 4 报告）。
 * 保留它是因为它把"档位必须是整数"这条意图写在代码上，且 `BANDS` 将来若混入非整数它就是活的；
 * 但**绝不声称它被测试锁住**——它与 Task 3 那条"连续同法即拒"属同一族：冗余、无害、有据可查。
 *
 * @throws {TypeError} 非法档位（含非整数、越界、非数字）
 */
function assertBand(band) {
  if (!Number.isInteger(band) || !BANDS.includes(band)) {
    throw new TypeError(`难度档必须是 ${BANDS.join(' / ')} 之一，收到 ${JSON.stringify(band)}`);
  }
}

/** 取某档的行为参数（冻结对象）。@throws {TypeError} 非法档位 */
export function bandRules(band) {
  assertBand(band);
  return RULES[band];
}

/** 升一档（到顶幂等）。@throws {TypeError} 非法档位 */
export function stepUp(band) {
  assertBand(band);
  return BANDS[Math.min(BANDS.indexOf(band) + 1, BANDS.length - 1)];
}

/** 降一档（到底幂等）。@throws {TypeError} 非法档位 */
export function stepDown(band) {
  assertBand(band);
  return BANDS[Math.max(BANDS.indexOf(band) - 1, 0)];
}
