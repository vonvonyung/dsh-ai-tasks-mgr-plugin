/**
 * AI 任务台 × DSH 插件 —— 浏览器半边（跑在 DSH 客户端里）。
 *
 * 两个挂点：
 *   ① rightbar              —— 「AI 任务台」面板：顶部一条健康条 + iframe 里是我们的整块面板（?embed=1 嵌入模式）
 *   ② settings.section      —— 设置里一节「AI 任务台」：后端地址、怎么起、出错怎么办
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

    /** 客户端侧需要的服务：插槽注册表 */
    const inject = ['slots'];

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

    /** ① 面板：健康条 + iframe（embed=1：隐藏我们自己的侧栏/顶栏，避免两层导航） */
    function AitmPanel() {
      const [cfg, reload] = useAitmConfig();
      const [nonce, setNonce] = react.useState(0);
      const [view, setView] = react.useState('board');
      const ready = Boolean(cfg.base) && cfg.health?.ok;
      const src = cfg.base ? `${cfg.base}/?embed=1&view=${encodeURIComponent(view)}` : '';
      const tab = (id, text) =>
        jsx.jsx(
          'a',
          {
            key: id,
            style: { cursor: 'pointer', textDecoration: 'none', opacity: view === id ? 1 : 0.55, fontWeight: view === id ? 600 : 400 },
            onClick: () => setView(id),
          },
          text,
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
                  title: 'AI 任务台',
                  src,
                  style: { flex: 1, width: '100%', border: 'none', background: 'transparent', minHeight: 0 },
                })
              : jsx.jsxs(
                  'div',
                  {
                    style: { padding: 16, fontSize: 12.5, lineHeight: 1.7, opacity: 0.85 },
                    children: [
                      cfg.loading ? '正在拉起后端（首次启动要构建一次界面，约 3–5 秒）…' : 'AI 任务台后端没起来。',
                      !cfg.loading && cfg.error ? jsx.jsx('div', { style: { marginTop: 6, opacity: 0.8 }, children: `原因：${cfg.error}` }) : null,
                      !cfg.loading && !cfg.error
                        ? jsx.jsx('div', {
                            style: { marginTop: 6, opacity: 0.8 },
                            children: '检查 AITM_REPO 是否指向 AI 任务台仓库，以及那个仓库能不能跑 `node scripts/dev-web.mjs --prod`。',
                          })
                        : null,
                    ],
                  },
                  'status',
                ),
          ],
        },
      );
    }

    /** ② 设置节 */
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
      return jsx.jsxs('div', { className: 'aitm-settings-section', 'data-plugin': 'dsh-plugin-aitm', children: [
        jsx.jsx('h3', { children: 'AI 任务台' }, 'h'),
        jsx.jsxs('div', { style: { marginTop: 6 }, children: [
          row('后端', cfg.base ?? '(自动拉起)'),
          row('健康', cfg.loading ? '检查中…' : cfg.health?.ok ? `正常 · ${cfg.health.actions} 个动作` : '不可用'),
          row('仓库', cfg.repo ?? '—'),
          row('错误', cfg.error ?? '无'),
        ] }, 'rows'),
        jsx.jsx('p', { style: { fontSize: 12, opacity: 0.7, marginTop: 8 }, children: '环境变量：AITM_REPO（仓库路径）/ AITM_URL（连已有实例）/ AITM_SPAWN=0（只连不起）。改完重启 DSH 客户端。' }, 'hint'),
        jsx.jsx('a', { style: { fontSize: 12, textDecoration: 'underline', cursor: 'pointer' }, onClick: reload, children: '重新检查' }, 'reload'),
      ] });
    }

    function apply(ctx) {
      // 右侧栏面板（DSH 右侧栏的页签之一）
      ctx.slots.inject('rightbar', () =>
        ctx.slots.register({ name: 'rightbar', id: 'aitm', order: 30, label: () => 'AI 任务台', inject: () => ({}) }, AitmPanel),
      );
      // 设置节
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register({ name: 'settings.section', id: 'aitm', order: 40, label: () => 'AI 任务台', inject: () => ({}) }, AitmSection),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__components = { AitmPanel, AitmSection };
    return module.exports;
  },
});
