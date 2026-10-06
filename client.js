/**
 * AI 任务台 × DSH 插件 —— 浏览器半边（跑在 DSH 客户端里）。
 *
 * 挂点（**别再用 `rightbar`**：那是「座位」单占位槽，DSH 自己的 sidebar-right 要占它，
 * 谁先去注册谁就把对方顶掉 → 对方 apply 抛异常、整页白屏。踩过一次，见 README 第 7 条）：
 *   ① 右侧栏页签：`sidebarRightTabs.register({id, kind})` 声明类型 +
 *      `sidebar.right.pane.tab`（主体）/ `sidebar.right.pane.tab.title`（页签头）两个 keyed 槽
 *   ② 设置里一节「AI 任务台」：`settings.section`
 *   ③ 对话里的工具卡：`tool.call.toolview`（keyed，key = 我们的工具名）—— 想法卡 / 列表卡 / 合集卡
 *
 * 浏览器里看不见 Node：后端地址从宿主半边注册的 `/aitm-plugin/config` 拿（同源，直接 fetch）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-aitm',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const react = require('react');
    const jsx = require('react/jsx-runtime');

    /** 客户端侧需要的服务：插槽注册表 + 右侧栏（页签类型表与打开页签的能力）+ 文案表 */
    const inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'locale'];

    /** 实现身份（tab 系统的唯一 id，也是 body/title 两个 keyed 槽的 key） */
    const TAB_ID = 'dsh-plugin-aitm';
    /** 类型判别符：openTab 用的名字 */
    const TAB_KIND = 'aitm';
    const TITLE = 'AI 任务台';

    const CONFIG_URL = '/aitm-plugin/config';

    /** 工具卡的文案（locale 表，跟 DSH 官方插件的写法一致） */
    const NS = 'aitm';
    const zh = {
      'card.openPanel': '在面板里看',
      'card.idea.created': '已进灵感箱',
      'card.idea.changed': '状态已改',
      'card.idea.failed': '没写成',
      'card.idea.id': '编号',
      'card.ideaList.title': '想法',
      'card.ideaList.total': '共 {n} 条',
      'card.ideaList.empty': '（这个筛选下没有想法）',
      'card.feed.title': '今日新闻合集',
      'card.feed.github': 'GitHub',
      'card.feed.bilibili': 'B站',
      'card.feed.favorites': '收藏',
      'card.health.title': '后端',
      'card.health.ok': '正常',
      'card.health.bad': '不可用',
      'card.running': '正在处理…',
      'card.fallback': 'AI 任务台',
      'card.noMeta': '（这次调用没有结构化数据，下面是原始返回）',
    };
    const en = {
      'card.openPanel': 'Open in panel',
      'card.idea.created': 'Saved to inbox',
      'card.idea.changed': 'Status changed',
      'card.idea.failed': 'Not saved',
      'card.idea.id': 'id',
      'card.ideaList.title': 'Ideas',
      'card.ideaList.total': '{n} total',
      'card.ideaList.empty': '(no ideas under this filter)',
      'card.feed.title': "Today's feed",
      'card.feed.github': 'GitHub',
      'card.feed.bilibili': 'Bilibili',
      'card.feed.favorites': 'Favorites',
      'card.health.title': 'Backend',
      'card.health.ok': 'healthy',
      'card.health.bad': 'unavailable',
      'card.running': 'Working…',
      'card.fallback': 'AI tasks',
      'card.noMeta': '(no structured payload for this call; raw result below)',
    };

    /** 状态徽章配色（跟着 DSH 的语义色走，取不到就退回我们自己的） */
    const STATUS_COLOR = {
      inbox: ['rgba(56,139,253,0.15)', '#388bfd'],
      scoping: ['rgba(219,171,10,0.18)', '#bb8009'],
      ready: ['rgba(46,160,67,0.15)', '#2ea043'],
      developing: ['rgba(163,113,247,0.18)', '#8957e5'],
      review: ['rgba(219,171,10,0.18)', '#bb8009'],
      done: ['rgba(46,160,67,0.15)', '#1a7f37'],
      archived: ['rgba(127,127,127,0.18)', '#6e7781'],
    };
    const T = {
      card: {
        border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.28))',
        borderRadius: 10,
        padding: '10px 12px',
        marginTop: 6,
        background: 'color-mix(in srgb, var(--dsh-color-bg-elevated, #ffffff) 92%, transparent)',
      },
      head: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
      title: { fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      sub: { fontSize: 11.5, opacity: 0.7, marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      row: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginTop: 5, minWidth: 0 },
      rowTitle: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      button: {
        marginLeft: 'auto',
        flex: 'none',
        fontSize: 11.5,
        padding: '2px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.35))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      dot: (ok) => ({ width: 8, height: 8, borderRadius: 999, flex: 'none', background: ok ? '#2ea043' : '#d29922' }),
      chip: (status) => {
        const [bg, fg] = STATUS_COLOR[status] ?? ['rgba(127,127,127,0.18)', '#6e7781'];
        return { fontSize: 11, lineHeight: '16px', padding: '0 6px', borderRadius: 999, background: bg, color: fg, flex: 'none' };
      },
      pre: {
        margin: '6px 0 0',
        padding: 8,
        borderRadius: 6,
        background: 'rgba(127,127,127,0.12)',
        fontSize: 11,
        maxHeight: 160,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
      },
    };

    /** 把 argsRaw / 结果文本尽量解析成对象（解析不了就返回 null） */
    const parseJson = (raw) => {
      if (typeof raw !== 'string' || raw.trim() === '') return null;
      try {
        const v = JSON.parse(raw);
        return v && typeof v === 'object' ? v : null;
      } catch {
        return null;
      }
    };

    /** 工具结果里的文本（照抄 DSH 官方工具行对 content 的处理） */
    const resultText = (block) => {
      if (!block || !('kind' in block)) return '';
      const parts = [];
      for (const item of block.content ?? []) parts.push(item?.type === 'text' ? String(item.text ?? '') : JSON.stringify(item));
      if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error?.name ?? 'Error'}: ${block.error?.code ?? ''}`);
      return parts.join('\n');
    };

    /* ─────────── 对话里的工具卡（tool.call.toolview） ─────────── */

    /** DSH 官方原子组件（静态模块，取不到就整块降级成纯文本样式，绝不让卡片炸掉会话） */
    const prim = (() => {
      try {
        return require('@deepseek-ai/dsh-client-ui-primitives') ?? {};
      } catch {
        return {};
      }
    })();
    const Icon = (name) => (typeof prim[name] === 'function' ? prim[name] : null);

    /** 「在面板里看」由 apply() 接上右侧栏（组件本身保持纯粹、可离线渲染） */
    let openAitmPanel = () => {};

    const isMeta = (v) => v && typeof v === 'object' && !Array.isArray(v);

    /** 状态徽章（文案就是状态名，颜色按语义分档） */
    const statusChip = (status) =>
      jsx.jsx('span', { style: T.chip(status), children: String(status ?? '?') }, 'chip');

    /** 卡片骨架：左边一个小图标，右上角「在面板里看」 */
    function Card({ icon, title, children, accent, t }) {
      const Glyph = Icon(icon);
      return jsx.jsxs('div', { style: T.card, 'data-plugin': 'dsh-plugin-aitm', children: [
        jsx.jsxs('div', { style: T.head, children: [
          Glyph ? jsx.jsx(Glyph, { size: 14 }) : jsx.jsx('span', { style: T.dot(Boolean(accent)) }, 'dot'),
          jsx.jsx('span', { style: T.title, children: title }, 'title'),
          jsx.jsx('button', { type: 'button', style: T.button, onClick: () => openAitmPanel(), children: t('card.openPanel') }, 'open'),
        ] }, 'head'),
        children,
      ] });
    }

    /** 正在跑：给「这次要干什么」的一句话，而不是一个转圈 */
    function RunningCard({ toolName, args, t }) {
      const what =
        toolName === 'aitm_idea_create' ? `记一条想法：${String(args.title ?? '…')}`
        : toolName === 'aitm_idea_set_status' ? `改想法状态：${String(args.id ?? '?')} → ${String(args.status ?? '?')}`
        : toolName === 'aitm_idea_list' ? '查想法'
        : toolName === 'aitm_feed_today' ? '读今日合集'
        : '健康检查';
      const Shimmer = prim.TextShimmer;
      return jsx.jsx(Card, {
        t,
        icon: 'IconSparkleRegular',
        title: `AI 任务台 · ${what}`,
        children: Shimmer
          ? jsx.jsx(Shimmer, { active: true, children: t('card.running') }, 'running')
          : jsx.jsx('div', { style: T.sub, children: t('card.running') }, 'running'),
      });
    }

    /** 失败：把原因原样给出（别只说「失败了」） */
    function FailedCard({ meta, text, toolName, t }) {
      const reason = meta?.error ?? text?.split('\n')[0] ?? '未知原因';
      return jsx.jsx(Card, {
        t,
        icon: 'IconWarningOutlineRegular',
        title: `AI 任务台 · ${toolName} ${t('card.idea.failed')}`,
        children: jsx.jsx('div', { style: { ...T.sub, color: '#d1242f' }, children: String(reason).slice(0, 400) }, 'why'),
      });
    }

    /** 想法卡（新建 / 改状态） */
    function IdeaCard({ meta, args, t }) {
      const title = String(meta.title ?? args.title ?? '(无标题)');
      const changed = meta.action === 'status';
      return jsx.jsx(Card, {
        t,
        icon: changed ? 'IconChecklistOutlineRegular' : 'IconLightOutlineRegular',
        title: `${title}`,
        accent: true,
        children: jsx.jsxs('div', { style: T.sub, children: [
          statusChip(meta.status),
          jsx.jsx('span', { children: changed ? t('card.idea.changed') : t('card.idea.created') }, 'what'),
          meta.id ? jsx.jsx('span', { style: { opacity: 0.6 }, children: `${t('card.idea.id')} ${String(meta.id)}` }, 'id') : null,
        ] }, 'sub'),
      });
    }

    /** 想法列表卡 */
    function IdeaListCard({ meta, t }) {
      const counts = meta.counts && typeof meta.counts === 'object' ? meta.counts : {};
      const chips = Object.entries(counts).filter(([, n]) => Number(n) > 0);
      const rows = Array.isArray(meta.ideas) ? meta.ideas : [];
      return jsx.jsx(Card, {
        t,
        icon: 'IconFlatListOutlineRegular',
        title: `${t('card.ideaList.title')} · ${t('card.ideaList.total', { n: String(meta.total ?? rows.length) })}`,
        children: jsx.jsxs('div', { children: [
          chips.length
            ? jsx.jsx('div', { style: T.sub, children: chips.map(([k, n]) => jsx.jsxs('span', { style: { ...T.chip(k), display: 'inline-flex', gap: 4 }, children: [k, ` ${String(n)}`] }, k)) }, 'chips')
            : null,
          rows.length
            ? rows.slice(0, 6).map((i) => jsx.jsxs('div', { style: T.row, children: [
                statusChip(i.status),
                jsx.jsx('span', { style: T.rowTitle, children: String(i.title ?? i.id) }, 't'),
              ] }, String(i.id)))
            : jsx.jsx('div', { style: T.sub, children: t('card.ideaList.empty') }, 'empty'),
        ] }, 'body'),
      });
    }

    /** 今日合集卡 */
    function FeedCard({ meta, t }) {
      const rows = Array.isArray(meta.top) ? meta.top : [];
      const stat = (label, n) => jsx.jsxs('span', { style: { display: 'inline-flex', gap: 4, alignItems: 'baseline' }, children: [
        jsx.jsx('span', { style: { opacity: 0.65 }, children: label }, 'l'),
        jsx.jsx('span', { style: { fontWeight: 600 }, children: String(n) }, 'n'),
      ] }, label);
      return jsx.jsx(Card, {
        t,
        icon: 'IconGlobeOutlineRegular',
        title: t('card.feed.title'),
        children: jsx.jsxs('div', { children: [
          jsx.jsx('div', { style: T.sub, children: [
            stat(t('card.feed.github'), meta.github ?? 0),
            stat(t('card.feed.bilibili'), meta.bilibili ?? 0),
            stat(t('card.feed.favorites'), meta.favorites ?? 0),
          ] }, 'stats'),
          rows.slice(0, 6).map((x, i) => jsx.jsxs('div', { style: T.row, children: [
            jsx.jsx('span', { style: T.chip(x.source), children: String(x.source ?? '?') }, 'src'),
            jsx.jsx('span', { style: T.rowTitle, children: String(x.title ?? '') }, 't'),
          ] }, `${String(x.source)}-${String(i)}`)),
        ] }, 'body'),
      });
    }

    /** 健康检查卡 */
    function HealthCard({ meta, t }) {
      const ok = Boolean(meta.ok);
      return jsx.jsx(Card, {
        t,
        icon: ok ? 'IconCheckCircleOutlineRegular' : 'IconWarningOutlineRegular',
        title: `${t('card.health.title')} · ${ok ? t('card.health.ok') : t('card.health.bad')}`,
        accent: ok,
        children: jsx.jsxs('div', { style: T.sub, children: [
          meta.actions !== null && meta.actions !== undefined ? jsx.jsx('span', { children: `${String(meta.actions)} action` }, 'a') : null,
          meta.apiRev ? jsx.jsx('span', { children: `apiRev=${String(meta.apiRev)}` }, 'r') : null,
          meta.version ? jsx.jsx('span', { children: `v${String(meta.version)}` }, 'v') : null,
          meta.dataDir ? jsx.jsx('span', { style: { opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: String(meta.dataDir) }, 'd') : null,
        ] }, 'sub'),
      });
    }

    /** 兜底：没有 meta（老会话 / 别的来源）就把原始文本收进卡片，绝不留白 */
    function FallbackCard({ text, toolName, t }) {
      return jsx.jsx(Card, {
        t,
        icon: 'IconSparkleRegular',
        title: `${t('card.fallback')} · ${toolName}`,
        children: text
          ? jsx.jsxs('div', { children: [
              jsx.jsx('div', { style: T.sub, children: t('card.noMeta') }, 'hint'),
              jsx.jsx('pre', { style: T.pre, children: text.slice(0, 800) }, 'text'),
            ] }, 'body')
          : null,
      });
    }

    /**
     * 我们五个工具共用的工具卡：按阶段 + `block.meta`（宿主侧 presentationMeta 投影）分支渲染。
     * 兼容 DSH 的三种阶段：preparing（只有 callId）/ start（有 argsRaw）/ result（有 content + meta）。
     */
    function AitmToolCard(props) {
      const block = props?.block;
      const t = props?.t ?? ((k) => k);
      const toolName = String(props?.toolName ?? 'aitm');
      const phase = props?.phase;
      if (!block || typeof block !== 'object' || !('kind' in block)) {
        const argsRaw = phase === 'start' && typeof block?.argsRaw === 'string' ? block.argsRaw : '';
        return RunningCard({ toolName, args: parseJson(argsRaw) ?? {}, t });
      }
      const args = parseJson(block.call?.argsRaw) ?? {};
      const meta = isMeta(block.meta) ? block.meta : null;
      const text = resultText(block);
      if (block.isError || block.error || meta?.ok === false) return FailedCard({ meta, text, toolName, t });
      switch (meta?.kind) {
        case 'idea':
          return IdeaCard({ meta, args, t });
        case 'idea-list':
          return IdeaListCard({ meta, t });
        case 'feed':
          return FeedCard({ meta, t });
        case 'health':
          return HealthCard({ meta, t });
        default:
          return FallbackCard({ text, toolName, t });
      }
    }

    /** 我们注册了工具卡的工具名（keyed 槽的 key） */
    const CARD_TOOLS = ['aitm_health', 'aitm_idea_list', 'aitm_feed_today', 'aitm_idea_create', 'aitm_idea_set_status'];

    /** 拿后端地址（失败也不抛，面板里给出人话） */
    function useAitmConfig() {
      const [cfg, setCfg] = react.useState({ loading: true });
      const load = react.useCallback(async () => {
        setCfg((c) => ({ ...c, loading: true }));
        try {
          const res = await fetch(CONFIG_URL, { headers: { accept: 'application/json' } });
          const body = await res.json();
          let health = null;
          if (body?.base) {
            try {
              const h = await fetch(`${body.base}/api/health`);
              health = h.ok ? await h.json() : { ok: false };
            } catch {
              health = { ok: false };
            }
          }
          setCfg({ loading: false, ...body, health });
        } catch (err) {
          setCfg({ loading: false, base: null, error: String(err?.message ?? err) });
        }
      }, []);
      react.useEffect(() => {
        load();
      }, [load]);
      return [cfg, load];
    }

    const BAR = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 10px',
      borderBottom: '1px solid var(--dsh-color-border, #d8dae0)',
      fontSize: 12,
      flex: 'none',
    };
    const DOT = (ok) => ({ width: 8, height: 8, borderRadius: 999, background: ok ? '#2ea043' : '#d29922', flex: 'none' });
    const LINK = { marginLeft: 'auto', textDecoration: 'underline', cursor: 'pointer', opacity: 0.8 };

    /** ① 页签主体：健康条 + 视图切换 + iframe（?embed=1：藏掉我们自己的导航，避免两层） */
    function AitmPanel() {
      const [cfg, reload] = useAitmConfig();
      const [nonce, setNonce] = react.useState(0);
      const [view, setView] = react.useState('board');
      const ready = Boolean(cfg.base) && cfg.health?.ok;
      // 后端身份：老实例（apiRev 不够）不能装作可用 —— 否则工具会报「未知接口：feed.get」
      const rev = cfg.identity?.apiRev ?? cfg.health?.apiRev ?? null;
      const stale = cfg.error ? /旧版|apiRev/.test(cfg.error) : rev !== null && rev < (cfg.apiRevRequired ?? 2);
      const src = cfg.base ? `${cfg.base}/?embed=1&view=${encodeURIComponent(view)}` : '';
      const tab = (id, text) =>
        jsx.jsx(
          'a',
          {
            style: { cursor: 'pointer', textDecoration: 'none', opacity: view === id ? 1 : 0.55, fontWeight: view === id ? 600 : 400, fontSize: 12 },
            onClick: () => setView(id),
            children: text,
          },
          id,
        );
      return jsx.jsxs(
        'div',
        {
          className: 'aitm-panel',
          'data-plugin': 'dsh-plugin-aitm',
          style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
          children: [
            jsx.jsxs(
              'div',
              {
                style: BAR,
                children: [
                  jsx.jsx('span', { style: DOT(ready), title: ready ? '后端正常' : '后端未就绪' }, 'dot'),
                  tab('board', '看板'),
                  tab('calendar', '日历'),
                  tab('feed', '合集'),
                  jsx.jsx('a', { style: LINK, onClick: () => { setNonce((n) => n + 1); reload(); }, children: '刷新' }, 'reload'),
                  jsx.jsx('a', { style: { ...LINK, marginLeft: 10 }, target: '_blank', rel: 'noreferrer', href: cfg.base ?? '#', children: '新窗口' }, 'open'),
                ],
              },
              'bar',
            ),
            ready
              ? jsx.jsx('iframe', {
                  key: `${nonce}-${view}`,
                  title: TITLE,
                  src,
                  style: { flex: 1, width: '100%', border: 'none', background: 'transparent', minHeight: 0 },
                })
              : jsx.jsxs(
                  'div',
                  {
                    style: { padding: 16, fontSize: 12.5, lineHeight: 1.7, opacity: 0.85 },
                    children: [
                      cfg.loading
                        ? '正在拉起后端（首次启动要构建一次界面，约 3–5 秒）…'
                        : stale
                          ? '连上的后端是旧版，这个面板用不了。'
                          : 'AI 任务台后端没起来。',
                      !cfg.loading && cfg.error ? jsx.jsx('div', { style: { marginTop: 6, opacity: 0.8 }, children: `原因：${cfg.error}` }) : null,
                      !cfg.loading && !cfg.error
                        ? jsx.jsx('div', {
                            style: { marginTop: 6, opacity: 0.8 },
                            children: stale
                              ? `这个实例是 ${cfg.identity?.version ?? '未知版本'}（apiRev=${String(rev)}，需要 ≥ ${String(cfg.apiRevRequired ?? 2)}）。` +
                                '处理：清掉 %TEMP%/aitm-dsh-backend.json 并确认没有遗留的 dev-web 进程，然后确认 AITM_REPO 指向最新仓库（已 git pull）再重启 DSH。'
                              : '检查 AITM_REPO 是否指向 AI 任务台仓库，以及那个仓库能不能跑 `node scripts/dev-web.mjs --prod`。',
                          })
                        : null,
                      // 起不来时把「在哪个目录起、缺什么、后端日志尾巴」直接摊在面板里 —— 报错要能照着修
                      !cfg.loading && cfg.repo
                        ? jsx.jsxs('div', { style: { marginTop: 10, fontSize: 11.5, opacity: 0.75, lineHeight: 1.6 }, children: [
                            jsx.jsx('div', { children: `仓库：${cfg.repo}` }, 'repo'),
                            cfg.repoProblem ? jsx.jsx('div', { style: { color: '#d1242f' }, children: `自检：${cfg.repoProblem}` }, 'problem') : null,
                            cfg.tail?.length
                              ? jsx.jsxs('div', { children: [
                                  jsx.jsx('div', { style: { marginTop: 4 }, children: '后端日志（尾部）：' }, 't'),
                                  jsx.jsx('pre', {
                                    style: { margin: '4px 0 0', padding: 8, maxHeight: 180, overflow: 'auto', background: 'rgba(127,127,127,0.12)', borderRadius: 4, fontSize: 11, whiteSpace: 'pre-wrap' },
                                    children: cfg.tail.slice(-12).join('\n'),
                                  }, 'log'),
                                ] }, 'tail')
                              : null,
                          ] }, 'diag')
                        : null,
                    ],
                  },
                  'status',
                ),
          ],
        },
      );
    }

    /** 页签头（右侧栏那一小条） */
    function AitmTabTitle() {
      return jsx.jsx('span', { children: TITLE });
    }

    /** 设置里的一节 */
    function AitmSection() {
      const [cfg, reload] = useAitmConfig();
      const row = (k, v) =>
        jsx.jsxs(
          'div',
          { style: { display: 'flex', gap: 10, fontSize: 12.5, marginBottom: 4 }, children: [
            jsx.jsx('span', { style: { width: 110, opacity: 0.7 }, children: k }, 'k'),
            jsx.jsx('span', { children: v ?? '—' }, 'v'),
          ] },
          k,
        );
      const rev = cfg.identity?.apiRev ?? cfg.health?.apiRev ?? null;
      const revRequired = cfg.apiRevRequired ?? 2;
      const stale = rev !== null && rev < revRequired;
      return jsx.jsxs('div', { className: 'aitm-settings-section', 'data-plugin': 'dsh-plugin-aitm', children: [
        jsx.jsx('h3', { children: TITLE }, 'h'),
        jsx.jsxs('div', { style: { marginTop: 6 }, children: [
          row('后端', cfg.base ?? '(自动拉起)'),
          row('健康', cfg.loading ? '检查中…' : cfg.health?.ok ? `正常 · ${cfg.health.actions} 个动作` : '不可用'),
          row('版本', cfg.identity?.version ? `${cfg.identity.version}（apiRev=${String(rev ?? '?')}，需要 ≥ ${String(revRequired)}）` : cfg.base ? '旧版（health 里没有身份字段）' : '—'),
          row('数据目录', cfg.identity?.dataDir ?? cfg.health?.dataDir ?? '—'),
          row('仓库', cfg.repo ?? '—'),
          row('错误', cfg.error ?? '无'),
        ] }, 'rows'),
        stale
          ? jsx.jsx('p', { style: { fontSize: 12, color: '#d1242f', marginTop: 8 }, children: '后端版本不匹配：这个实例没有 feed.* 接口，面板与工具都会失败。按上面的处理步骤换到最新仓库起的实例。' }, 'stale')
          : null,
        jsx.jsx('p', { style: { fontSize: 12, opacity: 0.7, marginTop: 8 }, children: '环境变量：AITM_REPO（仓库路径）/ AITM_URL（连已有实例）/ AITM_SPAWN=0（只连不起）。改完重启 DSH 客户端。' }, 'hint'),
        jsx.jsx('a', { style: { fontSize: 12, textDecoration: 'underline', cursor: 'pointer' }, onClick: reload, children: '重新检查' }, 'reload'),
      ] });
    }

    function apply(ctx) {
      // ⓪ 文案表（工具卡用 props.t 取）
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'aitm.dictionaries');
      // 「在面板里看」= 切到我们自己的右侧栏页签（没有会话时 openTab 会抛，吞掉即可）
      openAitmPanel = () => {
        try {
          ctx.sidebarRight.openTab(TAB_KIND);
        } catch {
          /* 没有会话/面板不可用时点不动，算了 */
        }
      };
      // ⓪' 对话里的工具卡：五个工具各注册一张（keyed，key = 工具名；没有就退回 DSH 的通用行）
      for (const tool of CARD_TOOLS) {
        ctx.effect(
          () =>
            ctx.slots.inject('tool.call.toolview', () =>
              ctx.slots.register({ name: 'tool.call.toolview', key: tool, locale: NS }, AitmToolCard),
            ),
          `aitm.card.${tool}`,
        );
      }
      // ① 右侧栏页签类型（kind → 打开时用；id → body/title 两个 keyed 槽认这个 key）
      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            priority: 'extension',
            multiple: false,
            title: () => TITLE,
            guide: [{ id: 'open', order: 40, title: () => TITLE, description: () => '看板 / 日历 / 合集（只读）' }],
          }),
        'aitm.tab-type',
      );
      // ② 页签主体 / 页签头
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, inject: () => ({}) }, AitmPanel),
          ),
        'aitm.tab-body',
      );
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID, inject: () => ({}) }, AitmTabTitle),
          ),
        'aitm.tab-title',
      );
      // ③ 设置节
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register({ name: 'settings.section', id: TAB_ID, order: 40, label: () => TITLE, inject: () => ({}) }, AitmSection),
          ),
        'aitm.settings-section',
      );
      // ④ 顺手把面板打开一次：只在右侧栏本来就一个页签都没开的时候（不抢用户已开的东西）
      ctx.effect(() => {
        const timer = setTimeout(() => {
          try {
            const open = ctx.sidebarRight?.openTabs?.getSnapshot?.() ?? [];
            if (open.length === 0) ctx.sidebarRight.openTab(TAB_KIND);
          } catch {
            /* 打不开就算了，用户还能从右侧栏的「+」里进 */
          }
        }, 1500);
        return () => clearTimeout(timer);
      }, 'aitm.auto-open');
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__components = { AitmPanel, AitmTabTitle, AitmSection, AitmToolCard };
    /** 给 verify 用：客户端半边依赖的服务名（每个都必须有提供者，否则整块 pending → 白屏） */
    exports.__clientInject = [...inject];
    /** 给 verify 用：卡片注册了哪些工具名 */
    exports.__cardTools = CARD_TOOLS;
    return module.exports;
  },
});
