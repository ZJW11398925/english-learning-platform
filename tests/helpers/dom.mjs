// tests/helpers/dom.mjs
//
// 假 DOM：只实现 `mount()` 用到的那一小片（`createElement` / `append` / `replaceChildren` /
// `addEventListener` / `click`）。**不引 jsdom**——shared-context 要求零测试框架依赖。
//
// 为什么抽成共享文件（Task 7）：`tests/app-mount.test.mjs` 与 `tests/recognize-mount.test.mjs`
// 都要驱动"按拍照 → 按快门 → 看界面"这条链。两份各写一个假 DOM 的话，两边会各自漂移，
// 于是"装配层的行为"取决于哪一份夹具被用到——那正是这些测试要防的事。
//
// `doc` 的形状就是 `mount(root, { doc })` 要的注入点：`{ createElement }`。

/**
 * 造一个假元素。`click()` 返回回调的返回值（mount 的 click 回调是 async，测试要能 await 它的拒绝）。
 */
export function makeEl(tag) {
  const listeners = new Map();
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    className: '',
    textContent: '',
    value: '',
    disabled: false,
    attributes: {},
    setAttribute(k, v) { el.attributes[k] = v; },
    append(...nodes) { el.children.push(...nodes); },
    replaceChildren(...nodes) { el.children = nodes; },
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    /**
     * 触发一次任意类型的事件（12B 起 file input 的 change 要靠它驱动——
     * 浏览器里"选中文件"由文件选择器触发，假 DOM 里由测试直接喂）。
     * 多个监听器时返回它们结果的数组（与 click 同款）。
     */
    fire(type, event) {
      const fns = listeners.get(type) ?? [];
      const results = fns.map((fn) => fn(event ?? { type }));
      return results.length === 1 ? results[0] : Promise.all(results);
    },
    /** 触发一次 click；多个监听器时返回它们结果的数组。 */
    click() {
      return el.fire('click', { type: 'click' });
    },
  };
  if (el.tagName === 'VIDEO') {
    // 真 video 出画前 videoWidth/Height 为 0；这里给一个已出画的默认值，要测"按太早"就覆盖它。
    el.videoWidth = 640;
    el.videoHeight = 480;
    el.srcObject = null;
    el.playCalls = 0;
    el.play = async () => { el.playCalls += 1; };
  }
  return el;
}

/** 假 document 工厂：`mount()` 的 `doc` 注入点。 */
export const fakeDoc = { createElement: makeEl };

/** 深度遍历（含根）。 */
export const walk = (el) => [el, ...el.children.flatMap(walk)];

/** 按标签取元素。 */
export const byTag = (root, tag) => walk(root).filter((e) => e.tagName === tag.toUpperCase());

/** 按文案取按钮（`includes`，所以按钮文案可以带前缀图标之类）。 */
export const btn = (root, text) => byTag(root, 'button').find((b) => b.textContent.includes(text));

/** 整棵树的可见文本（含输入框的 value）。 */
export const text = (root) => walk(root).map((e) => `${e.textContent}${e.value}`).join(' ');

/** `.error` 元素的文本（mount 的报错区不在会被 replaceChildren 换掉的 body 里）。 */
export const errorText = (root) => walk(root).filter((e) => e.className === 'error').map((e) => e.textContent).join(' ');
