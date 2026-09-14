/**
 * 从一个物体名对应的可接受词集里判定"这次取到的词能不能用"。
 *
 * `acceptableSets` 是**预先声明**的：`{ mug: ['mug', 'cup'], kettle: ['kettle'] }`。
 * 候选由识物模型按置信度排序给出，但**是否可用只由可接受集决定**——模型给出的
 * `score` 不参与判定，因为高分上位词（`container`、`vessel`）对"学一个能指着说的
 * 具体名词"毫无价值：用户拍的是马克杯，学到 `container` 等于没学到。
 *
 * 因此：**候选不可接受就跳过；一个都没有就返回 `null`，绝不退而求其次返回上位词。**
 * 返回 `null` 是"这一轮取词失败"的正常表达，调用方据此走设计文档 §5.1 的
 * `recognize_failed` 档（第二次仍失败则退到手选词包），而不是把上位词当成功落盘。
 */
export function pickWord({ candidates, acceptableSets, exclude = [] }) {
  const accepted = new Set();
  for (const labels of Object.values(acceptableSets)) for (const l of labels) accepted.add(l);

  for (const c of candidates) {
    if (!accepted.has(c.label)) continue;
    if (exclude.includes(c.label)) continue;
    return { word: c.label, reason: `候选 ${c.label} 命中可接受集` };
  }
  return null;
}
