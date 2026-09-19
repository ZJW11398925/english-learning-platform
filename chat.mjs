// web/chat.mjs
//
// 对话客厅（VS1「客厅能聊起来」）的装配层：三屏（首启 / 客厅 / 设置）、引擎接线、
// TTS、词卡、仪表渲染。纯逻辑全在 `./units/chat/`（照 `./units/write/` 的先例：
// 模型经注入、零 DOM、Node 里可测）；本文件只做「把 DOM 事件接到引擎、把引擎结果
// 画成信笺」这一层。
//
// ── STUB 边界（任务书第六节，如实写进代码）───────────────────────────────────
//   · **无长期记忆**：人设卡与设置持久化 localStorage（elp.chat.persona.v1 /
//     elp.chat.history.v1 / elp.chat.* / elp.chat.usage.v1）；对话历史**单会话级**
//     ——刷新还在，换人设/清数据就没了，跨天的记忆是 VS3 的切片。
//   · **无教学时刻**：纯聊（提示词里明确「不纠正、不上课」，见 units/chat/prompt.mjs）。
//   · **不设调用数量上限**：成本由用户自控 + 透明仪表（每条微标 / 会话头 / 设置页）
//     承担，不由程序配额承担。每次调用的 usage 如实入账，**缺键印「—」绝不写 0**。
//   · 输入区三级台阶**仅占位按钮**（无模型调用）——VS2 的切片。
//   · 抽屉（我的本子）**本单不做**——VS3 的切片。
//
// ── 模块装载失败要如实说 ─────────────────────────────────────────────────────
// units 全部**动态 import**（照 write.mjs 的先例）：哪一环 404，屏上出现的是
// 「引擎还没接上 + 原因」，不是一片无解释的白屏。**绝不用演示数据顶上**。
//
// 零外部资源；TTS 用浏览器自带 speechSynthesis（本地、免费、无打分）；
// 词卡走 `./units/lexicon.mjs` 同源词库（沿 write.html 先例，含「没查到就如实说」）。

/** localStorage 键（本页只碰这几把 + 设置/账本模块自己的 elp.chat.*）。 */
const PERSONA_KEY = 'elp.chat.persona.v1';
const HISTORY_KEY = 'elp.chat.history.v1';

const el = (doc, tag, cls, text) => {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const safeStorage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

const hhmm = (ts) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 一段文本里 CJK 与拉丁字母谁多（TTS 选音色用；中文回复挑中文声）。 */
const cjkDominant = (text) => {
  const cjk = (String(text ?? '').match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = (String(text ?? '').match(/[A-Za-z]/g) ?? []).length;
  return cjk > latin;
};

/**
 * 装配对话客厅。
 * @param {Element} root 挂载点（`#app`）。
 * @param {object} [deps] 全部可选（测试/探针注入；生产缺省浏览器环境）：
 *   storage / fetchImpl / win / now / seedsUrl / callModel。
 */
export async function mountChat(root, deps = {}) {
  const doc = root.ownerDocument ?? globalThis.document;
  const storage = deps.storage !== undefined ? deps.storage : safeStorage();
  const fetchImpl = deps.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const win = deps.win ?? globalThis;
  const now = deps.now ?? (() => Date.now());
  const seedsUrl = deps.seedsUrl ?? './data/chat-seeds.json';

  // ── 动态装载（失败如实说，见文件头）─────────────────────────────────────
  let units;
  try {
    const [client, engine, settings, persona, seeds, meter, lexicon, speak] = await Promise.all([
      import('./units/chat/client.mjs'),
      import('./units/chat/engine.mjs'),
      import('./units/chat/settings.mjs'),
      import('./units/chat/persona.mjs'),
      import('./units/chat/seeds.mjs'),
      import('./units/chat/meter.mjs'),
      import('./units/lexicon.mjs'),
      import('./units/speak.mjs'),
    ]);
    units = { client, engine, settings, persona, seeds, meter, lexicon, speak };
  } catch (err) {
    root.replaceChildren(el(doc, 'p', 'errline',
      `对话引擎还没接上：${String(err?.message ?? err)}。这一页不做任何演示数据顶替。`));
    return;
  }

  const chatEngine = units.engine.createChatEngine({
    callModel: deps.callModel ?? units.client.callModel,
    now,
  });
  const lex = units.lexicon.createLexicon({
    fetch: (url) => fetchImpl(url),
    storage: storage === null ? null : {
      // 词库片缓存只借 localStorage 的读写口，键前缀由 lexicon 模块自己定（elp.lexicon.v2.*）
      getItem: (k) => storage.getItem(k),
      setItem: (k, v) => storage.setItem(k, v),
      removeItem: (k) => storage.removeItem(k),
    },
  });

  // ── 持久化（一个键一个定义处；读坏 = 没有，不修不炸）────────────────────
  const readJson = (key) => {
    try {
      const raw = storage?.getItem(key);
      return typeof raw === 'string' && raw.trim() !== '' ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };
  const writeJson = (key, value) => {
    try {
      storage?.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false; // 配额满/隐私模式：聊天照常，持久化少一次
    }
  };
  const loadPersona = () => units.persona.normalizePersona(readJson(PERSONA_KEY));
  const savePersona = (p) => writeJson(PERSONA_KEY, p);
  const validHistoryEntry = (e) => e !== null && typeof e === 'object' && !Array.isArray(e)
    && (e.role === 'user' || e.role === 'assistant')
    && typeof e.content === 'string' && e.content.trim() !== '';
  const loadHistory = () => {
    const raw = readJson(HISTORY_KEY);
    const msgs = (raw !== null && typeof raw === 'object' && Array.isArray(raw.messages))
      ? raw.messages.filter(validHistoryEntry)
      : [];
    return msgs.map((m) => ({
      role: m.role,
      content: m.content,
      usage: (m.usage !== null && typeof m.usage === 'object') ? m.usage : null,
      local: m.local === true,
      ts: Number.isFinite(m.ts) ? m.ts : null,
    }));
  };
  const saveHistory = (msgs) => writeJson(HISTORY_KEY, { version: 1, messages: msgs });
  const clearConversation = () => {
    try { storage?.removeItem(PERSONA_KEY); } catch { /* 幂等 */ }
    try { storage?.removeItem(HISTORY_KEY); } catch { /* 幂等 */ }
  };
  const wipeEverything = () => {
    clearConversation();
    units.settings.clearSettings(storage);
    try { storage?.removeItem(units.meter.USAGE_LEDGER_KEY); } catch { /* 幂等 */ }
  };

  // ── 会话状态 ─────────────────────────────────────────────────────────────
  const state = {
    screen: null,               // 'onboard' | 'living' | 'set'
    persona: loadPersona(),     // 归一过的人设卡 | null
    history: loadHistory(),     // [{role, content, usage, local, ts}]
    settings: units.settings.loadSettings(storage),
    seeds: null,                // 挂载后异步取；null = 界面不印 P.S./小签内容，如实留空
    currentChallenge: null,
    busy: false,
    lastFailedText: null,
    session: { calls: 0, up: null, down: null }, // 本通（这次挂载以来）
  };

  try {
    state.seeds = await units.seeds.loadSeeds({ url: seedsUrl, fetch: fetchImpl });
  } catch {
    state.seeds = null; // 种子取不到不拦聊天：P.S. 与小签如实少印，不编内容
  }

  // ── 骨架 ─────────────────────────────────────────────────────────────────
  const stage = el(doc, 'div');
  stage.id = 'stage';
  root.replaceChildren(stage);
  const sections = {};
  const screenNames = ['onboard', 'living', 'set'];
  for (const name of screenNames) {
    const sec = el(doc, 'section', 'screen');
    sec.id = `screen-${name}`;
    stage.append(sec);
    sections[name] = sec;
  }
  const showScreen = (name) => {
    state.screen = name;
    for (const n of screenNames) sections[n].classList.toggle('on', n === name);
    win.scrollTo?.(0, 0);
  };

  // ══ 客厅 ═══════════════════════════════════════════════════════════════
  const living = sections.living;
  const header = el(doc, 'header', 'top');
  const who = el(doc, 'div', 'who', '');
  const whoSub = el(doc, 'div', 'who-sub', '人设 ▾');
  const whoWrap = el(doc, 'div');
  whoWrap.append(who, whoSub);
  const meterBtn = el(doc, 'button', 'meter', '今日 —');
  meterBtn.type = 'button';
  const menuBtn = el(doc, 'button', 'menu', '☰');
  menuBtn.type = 'button';
  menuBtn.setAttribute('aria-label', '打开设置');
  const meterDetail = el(doc, 'div', 'meter-detail');
  header.append(whoWrap, meterBtn, menuBtn, meterDetail);
  living.append(header);

  const hang = el(doc, 'div', 'hang');
  hang.append(el(doc, 'span', 'string'));
  const chalBtn = el(doc, 'button', 'tagbtn', '换个挑战');
  chalBtn.type = 'button';
  const chalPop = el(doc, 'div', 'challenge');
  hang.append(chalBtn, chalPop);
  living.append(hang);

  const flow = el(doc, 'main', 'flow');
  living.append(flow);

  const dock = el(doc, 'div', 'dock');
  const dockRow = el(doc, 'div', 'dock-row');
  const pen = el(doc, 'textarea', 'pen');
  pen.rows = 2;
  pen.setAttribute('placeholder', '想说什么，就说什么（Enter 发送 · Shift+Enter 换段）');
  const sendBtn = el(doc, 'button', 'send', '说');
  sendBtn.type = 'button';
  dockRow.append(pen, sendBtn);
  const stairs = el(doc, 'div', 'stairs');
  const stairsNote = el(doc, 'p', 'stairs-note',
    '三级台阶（给个开头 / 给一半 / 全给）在下一片接入；本单只占位，不调模型。');
  const stairDefs = [['① 给个开头', ''], ['② 给一半', 's2'], ['③ 全给', 's3']];
  for (const [label, cls] of stairDefs) {
    const b = el(doc, 'button', `stair ${cls}`.trim(), label);
    b.type = 'button';
    b.addEventListener('click', () => stairsNote.classList.toggle('on'));
    stairs.append(b);
  }
  dock.append(dockRow, stairs, stairsNote);
  living.append(dock);

  /** 把一段消息文本画成可点的英文词（中文整段没有空格，自然整块不可点）。 */
  const appendSay = (host, text) => {
    const normalize = units.lexicon.normalizeWord;
    for (const chunk of String(text ?? '').split(/(\s+)/)) {
      if (chunk === '') continue;
      if (normalize(chunk) === '') {
        host.append(chunk);
        continue;
      }
      const b = el(doc, 'button', 'w');
      b.type = 'button';
      b.textContent = chunk;
      b.setAttribute('data-w', normalize(chunk));
      host.append(b);
    }
  };

  /** 一封信笺（may=她的素纸 / me=我的撕边卡）。 */
  const renderLetter = (msg, { opener = false } = {}) => {
    const letter = el(doc, 'div', `letter ${msg.role === 'user' ? 'me' : 'may'}`);
    if (msg.role === 'user') {
      const paper = el(doc, 'div', 'paper');
      const say = el(doc, 'p', 'say');
      appendSay(say, msg.content);
      paper.append(say);
      letter.append(paper);
      const mark = el(doc, 'p', 'postmark', msg.ts === null ? '' : hhmm(msg.ts));
      letter.append(mark);
    } else {
      const say = el(doc, 'p', 'say');
      appendSay(say, msg.content);
      letter.append(say);
      if (opener) {
        const act = state.seeds === null
          ? null
          : units.seeds.activityForDay(state.seeds, units.meter.dayKey(new Date(now())));
        if (act !== null) {
          const ps = el(doc, 'p', 'ps');
          ps.append(el(doc, 'b', '', 'P.S. 今日活动'), doc.createTextNode(act.text));
          letter.append(ps);
        }
      } else if (msg.local !== true) {
        const line = el(doc, 'p', 'meterline');
        line.append(el(doc, 'span', '', units.meter.formatUsageLine(msg.usage)));
        const speakBtn = el(doc, 'button', 'speak', '读');
        speakBtn.type = 'button';
        speakBtn.addEventListener('click', () => speakMessage(msg.content));
        line.append(speakBtn);
        letter.append(line);
      }
    }
    return letter;
  };

  /** 开场引子：本地生成、零模型调用（P.S. 由当天日期轮换，见 seeds）。 */
  const ensureOpener = () => {
    if (state.history.length > 0) return;
    state.history.push({
      role: 'assistant',
      content: `你好呀，我是${units.persona.personaName(state.persona)}。今天想从哪聊起？`,
      usage: null,
      local: true,
      ts: now(),
    });
    saveHistory(state.history);
  };

  const renderFlow = () => {
    flow.replaceChildren();
    if (state.persona === null) return;
    state.history.forEach((msg, i) => {
      flow.append(renderLetter(msg, { opener: i === 0 && msg.role === 'assistant' }));
    });
  };

  const renderHeader = () => {
    if (state.persona === null) return;
    who.textContent = units.persona.personaName(state.persona);
    whoSub.textContent = `${units.persona.personaSubtitle(state.persona)} · 人设 ▾`;
    const today = units.meter.dayOf(units.meter.loadLedger(storage), units.meter.dayKey(new Date(now())));
    meterBtn.textContent = today.calls > 0
      ? `今日 ↑${units.meter.formatTokens(today.up)} ↓${units.meter.formatTokens(today.down)}`
      : '今日 —';
    const s = state.session;
    const aiLines = state.history
      .filter((m) => m.role === 'assistant' && m.local !== true)
      .slice(-8)
      .map((m) => `　${units.meter.formatUsageLine(m.usage)}`)
      .join('<br>');
    meterDetail.replaceChildren();
    const detail = el(doc, 'span');
    detail.innerHTML = `<b>token 明细（透明仪表 · 你的 Key：${state.settings.model === '' ? '未配置' : state.settings.model}）</b><br>`
      + `本通 ${s.calls} 次 · ↑${units.meter.formatTokens(s.up)} ↓${units.meter.formatTokens(s.down)}<br>`
      + `今日 ${today.calls} 次 · ↑${units.meter.formatTokens(today.up)} ↓${units.meter.formatTokens(today.down)}`
      + `${today.measured < today.calls ? `（${today.calls - today.measured} 条没给 usage，如实不计）` : ''}<br>`
      + (aiLines === '' ? '' : `${aiLines}<br>`)
      + `缓存命中按端点实报，缺键印「—」，不补 0`;
    meterDetail.append(detail);
  };

  const scrollBottom = () => {
    win.requestAnimationFrame?.(() => {
      const scroller = doc.documentElement;
      scroller.scrollTop = scroller.scrollHeight;
    });
  };

  // ── 发送一条 ────────────────────────────────────────────────────────────
  const setBusy = (busy) => {
    state.busy = busy;
    sendBtn.disabled = busy;
    sendBtn.textContent = busy ? '…' : '说';
  };

  const sendText = async (rawText) => {
    const text = String(rawText ?? '').trim();
    if (text === '' || state.busy || state.persona === null) return;
    if (!units.settings.isConfigured(state.settings)) {
      const err = el(doc, 'p', 'errline');
      err.append(doc.createTextNode('还没配好模型服务（baseURL / Key / 模型名）。'));
      const go = el(doc, 'button', 'retry', '去设置 →');
      go.type = 'button';
      go.addEventListener('click', () => renderSettings());
      err.append(go);
      flow.append(err);
      return;
    }
    state.lastFailedText = null;
    const userMsg = { role: 'user', content: text, usage: null, ts: now() };
    state.history.push(userMsg);
    saveHistory(state.history);
    flow.append(renderLetter(userMsg));
    pen.value = '';
    scrollBottom();

    setBusy(true);
    const typing = el(doc, 'p', 'typing', '（她在写……）');
    flow.append(typing);
    scrollBottom();

    const past = state.history.slice(0, -1);
    const res = await chatEngine.reply({
      persona: state.persona,
      history: past,
      userText: text,
      replyLanguage: state.settings.replyLanguage,
      apiBase: state.settings.apiBase,
      apiKey: state.settings.apiKey,
      model: state.settings.model,
    });
    typing.remove();
    setBusy(false);

    if (res.ok !== true) {
      // 失败如实上屏 + 手动重发（绝不静默重试——上一形态 D2 的教训）。
      state.lastFailedText = text;
      const err = el(doc, 'p', 'errline', `这一次没接上（${res.reason}）：${res.detail}`);
      const retry = el(doc, 'button', 'retry', '重发');
      retry.type = 'button';
      retry.addEventListener('click', () => {
        err.remove();
        // 把刚才那条用户消息从历史与屏上撤掉，按一次干净的发送重来。
        state.history.pop();
        saveHistory(state.history);
        const letters = flow.querySelectorAll('.letter');
        if (letters.length > 0) letters[letters.length - 1].remove();
        sendText(text);
      });
      err.append(retry);
      flow.append(err);
      return;
    }

    const aiMsg = { role: 'assistant', content: res.reply, usage: res.usage, ts: now() };
    state.history.push(aiMsg);
    saveHistory(state.history);
    flow.append(renderLetter(aiMsg));

    // 仪表三层的第一、二层：微标已随信笺画上；这里入账并刷新会话头。
    state.session.calls += 1;
    if (res.usage !== null && typeof res.usage === 'object') {
      if (Number.isFinite(res.usage.prompt_tokens)) {
        state.session.up = (state.session.up ?? 0) + res.usage.prompt_tokens;
      }
      if (Number.isFinite(res.usage.completion_tokens)) {
        state.session.down = (state.session.down ?? 0) + res.usage.completion_tokens;
      }
    }
    units.meter.addUsage(storage, units.meter.dayKey(new Date(now())), res.usage);
    renderHeader();
    scrollBottom();
  };

  sendBtn.addEventListener('click', () => { sendText(pen.value); });
  pen.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      sendText(pen.value);
    }
  });

  menuBtn.addEventListener('click', () => renderSettings());
  whoSub.addEventListener('click', () => renderOnboard({ editing: true }));
  meterBtn.addEventListener('click', () => meterDetail.classList.toggle('on'));
  chalBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (state.seeds === null) {
      chalPop.replaceChildren(el(doc, 'span', '', '（种子文件这次没取到，如实不编）'));
    } else {
      state.currentChallenge = units.seeds.drawChallenge(state.seeds, {
        currentId: state.currentChallenge?.id ?? null,
      });
      chalPop.replaceChildren();
      chalPop.append(el(doc, 'b', '', '换个挑战'));
      chalPop.append(doc.createTextNode(state.currentChallenge.text));
    }
    chalPop.classList.toggle('on');
  });

  // ── 点词出卡（同源词库；沿 write.html 先例，含「没查到就如实说」）────────
  const speakWord = (word) => {
    units.speak.playWord(word, { win }).catch(() => { /* 本地免费示范音，失败不拦聊天 */ });
  };
  flow.addEventListener('click', async (ev) => {
    const target = ev.target;
    if (!(target instanceof doc.defaultView.Element)) return;
    const wordBtn = target.closest?.('button.w');
    if (wordBtn === null || wordBtn === undefined) return;
    const key = wordBtn.getAttribute('data-w');
    flow.querySelectorAll('button.w.open').forEach((b) => b.classList.remove('open'));
    flow.querySelectorAll('.cardwrap').forEach((c) => c.remove());
    wordBtn.classList.add('open');
    const host = wordBtn.closest('.letter') ?? flow;
    const card = el(doc, 'div', 'cardwrap');
    card.setAttribute('data-layer', 'card');
    card.setAttribute('data-card-for', key);
    card.append(el(doc, 'span', '', '（查词ing…）'));
    host.append(card);
    let entry = null;
    try {
      entry = await lex.lookup(key);
    } catch (err) {
      entry = null;
      card.setAttribute('data-card-error', String(err?.message ?? err).slice(0, 120));
    }
    card.replaceChildren();
    if (entry === null) {
      card.setAttribute('data-card-source', 'none');
      card.append(el(doc, 'span', 'wc-miss', '没查到'));
      const why = card.getAttribute('data-card-error') !== null
        ? `这次没能取到词库：${card.getAttribute('data-card-error')}`
        : '词典里没查到这一条';
      card.append(el(doc, 'span', 'wc-none', why));
    } else {
      card.setAttribute('data-card-source', 'lexicon');
      const head = el(doc, 'span', 'hw', entry.word);
      const meta = [
        entry.phonetic === null ? null : `/${entry.phonetic}/`,
        entry.pos,
        entry.collinsStars,
        entry.oxford === true ? '· 牛津3000' : null,
        ...(entry.tagLabels ?? []).map((t) => `· ${t}`),
        entry.frequency === null ? null : `· 词频 ${entry.frequency.label}`,
      ].filter((x) => x !== null && x !== '').join(' ');
      const zh = el(doc, 'span', 'wc-zh', entry.zh ?? '（这一条没有中文释义，如实不编）');
      const notes = [];
      if (typeof entry.lemmaForm === 'string' && entry.lemmaForm !== '') {
        notes.push(`${entry.lemmaForm} 是 ${entry.word} 的变形`);
      }
      if (Array.isArray(entry.exchange) && entry.exchange.length > 0) {
        notes.push(`变形：${entry.exchange.map((x) => `${x.label} ${x.form}`).join(' · ')}`);
      }
      notes.push('例句与搭配：暂缺');
      const none = el(doc, 'span', 'wc-none', notes.join(' ｜ '));
      const acts = el(doc, 'div', 'wc-acts');
      const listen = el(doc, 'button', 'wc-do', '听一下');
      listen.type = 'button';
      listen.addEventListener('click', () => speakWord(entry.word));
      acts.append(listen);
      card.append(head);
      if (meta !== '') card.append(el(doc, 'span', 'wc-meta', meta));
      card.append(zh, none, acts);
    }
  });

  // ── TTS：朗读 AI 消息（speechSynthesis，本地免费、无打分）────────────────
  const speakMessage = (text) => {
    const synth = win.speechSynthesis;
    const Ctor = win.SpeechSynthesisUtterance;
    if (synth === null || synth === undefined || typeof Ctor !== 'function') {
      return; // 没有语音合成就安静地不播（不拦聊天）
    }
    try {
      synth.cancel(); // 读下一条时让上一条闭嘴（同一时刻只读一条）
    } catch { /* 引擎不给 cancel 也不拦 */ }
    const lang = cjkDominant(text) ? 'zh-CN' : 'en-US';
    try {
      const u = new Ctor(text);
      const voice = units.speak.pickVoice(
        typeof synth.getVoices === 'function' ? synth.getVoices() : [],
        lang,
      );
      u.lang = voice?.lang ?? lang;
      if (voice !== null) {
        try { u.voice = voice; } catch { /* 只靠 lang 兜底 */ }
      }
      synth.speak(u);
    } catch { /* 构造/播放失败不拦聊天 */ }
  };

  // ══ 首启（邮寄单）══════════════════════════════════════════════════════
  const renderOnboard = ({ editing = false } = {}) => {
    const sec = sections.onboard;
    sec.replaceChildren();
    sec.className = 'screen ob';
    const formhead = el(doc, 'p', 'formhead', '✉ 第一步，也是唯一一步');
    const h1 = el(doc, 'h1', '', editing ? '改她的名片' : '写给她的一句话');
    const sub = el(doc, 'p', 'sub', '描述你想跟谁聊，剩下的交给她自己报名。');
    sec.append(formhead, h1, sub);

    const form = el(doc, 'div', 'ob-form');
    const desc = el(doc, 'textarea', 'desc');
    desc.rows = 3;
    desc.setAttribute('placeholder', '比如：一个在美国生活过的姐姐，爱聊日常，英文别太难');
    const go = el(doc, 'button', 'go', '就这么定');
    go.type = 'button';
    form.append(desc, go);
    const hint = el(doc, 'p', 'hint');
    sec.append(form, hint);

    const cardHost = el(doc, 'div');
    sec.append(cardHost);

    const renderHint = (text, bad = false, linkLabel = null) => {
      hint.replaceChildren();
      hint.append(document.createTextNode(`${text} `));
      if (linkLabel !== null) {
        const a = el(doc, 'a', '', linkLabel);
        a.addEventListener('click', () => renderSettings());
        hint.append(a);
      }
    };

    /** 人设卡（四个字段都可直接改；可重生成；进客厅）。 */
    const renderPersonaCard = (persona, lastDescription) => {
      cardHost.replaceChildren();
      sec.classList.add('done');
      const card = el(doc, 'div', 'persona');
      card.append(el(doc, 'div', 'flap'));
      const nm = el(doc, 'input', 'nm');
      nm.value = persona.name;
      nm.setAttribute('aria-label', '名字');
      card.append(nm);
      const fields = [
        ['身份背景', 'bio'],
        ['语气', 'tone'],
        ['英语难度', 'difficulty'],
      ];
      const inputs = { name: nm };
      for (const [label, field] of fields) {
        const row = el(doc, 'div', 'rowline');
        row.append(el(doc, 'span', 'k', label));
        const input = el(doc, 'input', 'in');
        input.value = persona[field];
        input.setAttribute('aria-label', label);
        row.append(input);
        card.append(row);
        inputs[field] = input;
      }
      const again = el(doc, 'button', 'again', '↻ 不像她？重新生成一张');
      again.type = 'button';
      again.addEventListener('click', () => generate(lastDescription));
      const backToForm = el(doc, 'button', 'again', '← 重写那句话描述');
      backToForm.type = 'button';
      backToForm.addEventListener('click', () => {
        sec.classList.remove('done');
        cardHost.replaceChildren();
      });
      const enter = el(doc, 'button', 'go', '进客厅 →');
      enter.type = 'button';
      enter.addEventListener('click', () => {
        const next = units.persona.normalizePersona({
          name: inputs.name.value,
          bio: inputs.bio.value,
          tone: inputs.tone.value,
          difficulty: inputs.difficulty.value,
        });
        if (next === null) {
          renderHint('四个格子都得有字（名字/身份背景/语气/英语难度），这张卡才存得进去。', true);
          return;
        }
        // 换/改人设 = 开一段新对话（人设变了，旧对话不再属于她）。
        state.persona = next;
        state.history = [];
        savePersona(next);
        ensureOpener();
        renderFlow();
        renderHeader();
        showScreen('living');
        pen.focus?.();
      });
      card.append(again, backToForm, enter);
      cardHost.append(card);
    };

    const generate = async (description) => {
      const d = String(description ?? '').trim();
      if (d === '') {
        renderHint('先写一句话描述你想跟谁聊。', true);
        return;
      }
      if (!units.settings.isConfigured(state.settings)) {
        renderHint('生成人设要调一次你的模型服务，还没配好。', false, '去设置 →');
        return;
      }
      go.disabled = true;
      go.textContent = '报名中…';
      renderHint('她在写自己的名片（这一次调用会如实记进仪表）……');
      const res = await chatEngine.generatePersona({
        description: d,
        apiBase: state.settings.apiBase,
        apiKey: state.settings.apiKey,
        model: state.settings.model,
      });
      go.disabled = false;
      go.textContent = '就这么定';
      if (res.ok !== true) {
        renderHint(`没生成出来（${res.reason}）：${res.detail}`, true);
        return;
      }
      units.meter.addUsage(storage, units.meter.dayKey(new Date(now())), res.usage);
      state.session.calls += 1;
      renderPersonaCard(res.persona, d);
    };

    go.addEventListener('click', () => generate(desc.value));

    if (editing && state.persona !== null) {
      // 改名片：表单与卡同屏出现（卡里的格子已填好，直接改、直接进客厅）。
      desc.value = `${state.persona.bio}，${state.persona.tone}`;
      renderPersonaCard(state.persona, desc.value);
    } else if (state.persona !== null) {
      renderPersonaCard(state.persona, `${state.persona.bio}，${state.persona.tone}`);
    } else {
      renderHint('生成人设会调一次模型（费用照实入仪表）；也可以先去配好服务再回来。', false, '设置 →');
    }
    showScreen('onboard');
  };

  // ══ 设置 ═══════════════════════════════════════════════════════════════
  const renderSettings = () => {
    const sec = sections.set;
    sec.replaceChildren();
    sec.className = 'screen set';
    const current = units.settings.loadSettings(storage);

    const h2 = el(doc, 'h2', '', '设置');
    const sub = el(doc, 'p', 'sub',
      '模型服务是你自己的（BYOK，零预置）：三件都填好才通。Key 只存这台设备的浏览器里，'
      + '只随请求头发给你自己填的端点。');
    sec.append(h2, sub);

    const baseIn = el(doc, 'input', 'in');
    baseIn.value = current.apiBase;
    baseIn.setAttribute('placeholder', 'https://你的端点/v1（OpenAI 兼容）');
    const keyIn = el(doc, 'input', 'in');
    keyIn.type = 'password';
    keyIn.value = current.apiKey;
    keyIn.setAttribute('placeholder', '你的 API Key（本地模型没 Key 就随便填个非空的）');
    keyIn.setAttribute('autocomplete', 'off');
    const modelIn = el(doc, 'input', 'in');
    modelIn.value = current.model;
    modelIn.setAttribute('placeholder', '模型名（在服务方文档里查，例如 chat 类）');
    for (const [label, input] of [['baseURL', baseIn], ['API Key', keyIn], ['模型名', modelIn]]) {
      const row = el(doc, 'div', 'rowline');
      row.append(el(doc, 'span', 'k', label), input);
      sec.append(row);
    }
    const save = el(doc, 'button', 'go', '保存');
    save.type = 'button';
    const msg = el(doc, 'p', 'msg');
    sec.append(save, msg);
    save.addEventListener('click', () => {
      const r = units.settings.saveProvider(storage, {
        apiBase: baseIn.value,
        apiKey: keyIn.value,
        model: modelIn.value,
      });
      msg.className = r.ok ? 'msg' : 'msg bad';
      msg.textContent = r.ok ? '存好了（就在这台设备的浏览器里）。' : r.error;
      if (r.ok) state.settings = units.settings.loadSettings(storage);
    });

    const langSec = el(doc, 'div', 'sec');
    langSec.append(el(doc, 'h3', '', 'AI 回复语言'));
    const langs = el(doc, 'div', 'langs');
    const langBtns = {};
    for (const [value, label] of [['en', '英语（缺省）'], ['zh', '中文']]) {
      const b = el(doc, 'button', 'langbtn', label);
      b.type = 'button';
      if (current.replyLanguage === value) b.classList.add('on');
      b.addEventListener('click', () => {
        const r = units.settings.saveReplyLanguage(storage, value);
        if (r.ok) {
          state.settings = units.settings.loadSettings(storage);
          for (const [v, btn] of Object.entries(langBtns)) btn.classList.toggle('on', v === value);
          msg.className = 'msg';
          msg.textContent = `她下一次回话就用${value === 'zh' ? '中文' : '英文'}了。`;
        }
      });
      langBtns[value] = b;
      langs.append(b);
    }
    langSec.append(langs);
    sec.append(langSec);

    const totalsSec = el(doc, 'div', 'sec');
    totalsSec.append(el(doc, 'h3', '', '累计（这台设备 · 透明仪表）'));
    const totals = units.meter.totalsOf(units.meter.loadLedger(storage));
    const totalsLine = el(doc, 'p', 'totals',
      `调用 ${totals.calls} 次 · ↑${units.meter.formatTokens(totals.up)} ↓${units.meter.formatTokens(totals.down)}`
      + `（${totals.measured}/${totals.calls} 条有 usage）· 跨 ${totals.days} 天`
      + `${totals.up === null ? ' —— 端点没给 usage 时如实不计，不补 0' : ''}`);
    totalsSec.append(totalsLine);
    sec.append(totalsSec);

    const dangerSec = el(doc, 'div', 'sec');
    dangerSec.append(el(doc, 'h3', '', '数据清除（本机，不可恢复）'));
    const wipe1 = el(doc, 'button', 'wipe', '清除对话与人设（保留设置与 Key）');
    wipe1.type = 'button';
    wipe1.addEventListener('click', () => {
      if (!win.confirm?.('清除对话与人设？这段对话就没了（本机操作，不经过任何服务器）。')) return;
      clearConversation();
      state.persona = null;
      state.history = [];
      renderOnboard();
    });
    const wipe2 = el(doc, 'button', 'wipe', '全部清除（含设置、Key 与用量账本）');
    wipe2.type = 'button';
    wipe2.addEventListener('click', () => {
      if (!win.confirm?.('全部清除？设置、Key、用量账本、对话与人设都从这台设备上删掉。')) return;
      wipeEverything();
      state.persona = null;
      state.history = [];
      state.settings = units.settings.loadSettings(storage);
      state.session = { calls: 0, up: null, down: null };
      renderOnboard();
    });
    dangerSec.append(wipe1, wipe2);
    sec.append(dangerSec);

    const back = el(doc, 'button', 'back', '← 回客厅');
    back.type = 'button';
    back.addEventListener('click', () => {
      if (state.persona === null) renderOnboard();
      else { renderHeader(); showScreen('living'); }
    });
    sec.append(back);
    showScreen('set');
  };

  // ══ 装配收尾 ═══════════════════════════════════════════════════════════
  if (state.persona === null) {
    renderOnboard();
  } else {
    ensureOpener();
    renderFlow();
    renderHeader();
    showScreen('living');
  }

  return {
    /** 探针/测试用的只读口（生产界面不用它）。 */
    state: () => ({
      persona: state.persona,
      historyLength: state.history.length,
      settings: { ...state.settings, apiKey: '（不外露）' },
      engine: chatEngine.state(),
      screen: state.screen,
    }),
  };
}
