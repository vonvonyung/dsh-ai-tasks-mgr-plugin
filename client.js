/**
 * AI 任务台 × DSH 插件 —— 浏览器半边（跑在 DSH 客户端里）。
 *
 * 挂点（**别再用 `rightbar`**：那是「座位」单占位槽，DSH 自己的 sidebar-right 要占它，
 * 谁先去注册谁就把对方顶掉 → 对方 apply 抛异常、整页白屏。踩过一次，见 README 第 7 条）：
 *   ① 右侧栏页签：`sidebarRightTabs.register({id, kind})` 声明类型 +
 *      `sidebar.right.pane.tab`（主体）/ `sidebar.right.pane.tab.title`（页签头）两个 keyed 槽
 *   ② 设置里一节「AI 任务台」：`settings.section`
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

    /** 客户端侧需要的服务：插槽注册表 + 右侧栏（页签类型表与打开页签的能力） */
    const inject = ['slots', 'sidebarRight', 'sidebarRightTabs'];

    /** 实现身份（tab 系统的唯一 id，也是 body/title 两个 keyed 槽的 key） */
    const TAB_ID = 'dsh-plugin-aitm';
    /** 类型判别符：openTab 用的名字 */
    const TAB_KIND = 'aitm';
    const TITLE = 'AI 任务台';

    const CONFIG_URL = '/aitm-plugin/config';

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
    exports.__components = { AitmPanel, AitmTabTitle, AitmSection };
    return module.exports;
  },
});
