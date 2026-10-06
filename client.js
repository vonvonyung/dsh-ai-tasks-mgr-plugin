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
      'card.ideaDetail.tasks': '任务',
      'card.ideaDetail.noBody': '（没有正文）',
      'card.task.title': '任务',
      'card.task.turns': '第 {n} 轮',
      'card.task.files': '{n} 个文件改动',
      'card.task.empty': '（还没有任务）',
      'card.calendar.title': '这一天',
      'card.calendar.month': '本月 {ideas} 想法 · {favs} 收藏',
      'card.calendar.nothing': '（这天什么都没记）',
      'card.repos.title': '仓库与工作区',
      'card.repos.summary': '{repos} 个仓库 · {worktrees} 个 worktree · {mb} MB',
      'card.repos.reclaim': '可回收 {n}',
      'card.backup.title': '备份',
      'card.backup.done': '已备份（{mode}）',
      'card.backup.files': '{n} 个文件',
      'card.backup.deduped': '和上一份一样，没重复落',
      'card.health.ok': '正常',
      'card.health.bad': '不可用',
      'card.running': '正在处理…',
      'card.fallback': 'AI 任务台',
      'card.noMeta': '（这次调用没有结构化数据，下面是原始返回）',
      /* 原生看板（不走 iframe 的那块） */
      'board.search': '搜索标题 / 正文',
      'board.all': '全部状态',
      'board.refresh': '刷新',
      'board.dropHere': '拖想法到这里',
      'board.star': '收藏',
      'board.unstar': '取消收藏',
      'board.repoGone': '仓库已删除',
      'board.loading': '正在取想法…',
      'board.empty': '这个筛选下没有想法',
      'board.filteredNote': '（计数始终是全量）',
      'board.counts': '全量：',
      'board.running': '执行中 {n} · 排队 {n2}',
      'board.back': '← 返回看板',
      'board.openFull': '在完整面板里打开',
      'board.detailLoading': '正在取详情…',
      'board.setFailed': '改状态失败：{msg}',
      'board.col.inbox': '灵感箱',
      'board.col.scoping': '梳理中',
      'board.col.ready': '可开发',
      'board.col.developing': '开发中',
      'board.col.review': '待验收',
      'board.col.blocked': '受阻',
      'board.col.done': '已完成',
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
      'card.ideaDetail.tasks': 'Tasks',
      'card.ideaDetail.noBody': '(no description)',
      'card.task.title': 'Task',
      'card.task.turns': 'turn {n}',
      'card.task.files': '{n} files changed',
      'card.task.empty': '(no tasks yet)',
      'card.calendar.title': 'This day',
      'card.calendar.month': '{ideas} ideas · {favs} favorites this month',
      'card.calendar.nothing': '(nothing on this day)',
      'card.repos.title': 'Repos & workspaces',
      'card.repos.summary': '{repos} repos · {worktrees} worktrees · {mb} MB',
      'card.repos.reclaim': '{n} reclaimable',
      'card.backup.title': 'Backup',
      'card.backup.done': 'Backed up ({mode})',
      'card.backup.files': '{n} files',
      'card.backup.deduped': 'identical to the last one; nothing new stored',
      'card.health.ok': 'healthy',
      'card.health.bad': 'unavailable',
      'card.running': 'Working…',
      'card.fallback': 'AI tasks',
      'card.noMeta': '(no structured payload for this call; raw result below)',
      // 看板（M3 原生；列名与 `src/shared/labels.ts` 的 IDEA_LABEL 一一对应）
      'board.search': 'Search title / body',
      'board.all': 'All statuses',
      'board.refresh': 'Refresh',
      'board.dropHere': 'Drag an idea here',
      'board.star': 'Star',
      'board.unstar': 'Unstar',
      'board.repoGone': 'repo deleted',
      'board.loading': 'Loading ideas…',
      'board.empty': 'No ideas under this filter',
      'board.filteredNote': '(counts always cover everything)',
      'board.counts': 'All: ',
      'board.running': '{n} running · {n2} queued',
      'board.back': '← Back to board',
      'board.openFull': 'Open in full panel',
      'board.detailLoading': 'Loading details…',
      'board.setFailed': 'Could not change status: {msg}',
      'board.col.inbox': 'Inbox',
      'board.col.scoping': 'Scoping',
      'board.col.ready': 'Ready',
      'board.col.developing': 'Developing',
      'board.col.review': 'Review',
      'board.col.blocked': 'Blocked',
      'board.col.done': 'Done',
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
        : toolName === 'aitm_idea_get' ? `看想法 ${String(args.id ?? '…')}`
        : toolName === 'aitm_feed_today' ? '读今日合集'
        : toolName === 'aitm_task_start' ? `开工 ${String(args.ideaId ?? '…')}`
        : toolName === 'aitm_task_status' ? '看任务进度'
        : toolName === 'aitm_calendar_day' ? `看日历 ${String(args.day ?? '今天')}`
        : toolName === 'aitm_repo_status' ? '看仓库与工作区'
        : toolName === 'aitm_backup_now' ? '立即备份'
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


    /** 想法详情卡（aitm_idea_get）：状态 + 标签 + 正文摘要 + 下面的任务 */
    function IdeaDetailCard({ meta, t }) {
      const tasks = Array.isArray(meta.tasks) ? meta.tasks : [];
      return jsx.jsx(Card, {
        t,
        icon: 'IconListPenOutlineRegular',
        title: String(meta.title ?? '(无标题)'),
        accent: true,
        children: jsx.jsxs('div', { children: [
          jsx.jsxs('div', { style: T.sub, children: [
            statusChip(meta.status),
            meta.priority ? jsx.jsx('span', { style: { opacity: 0.7 }, children: String(meta.priority) }, 'p') : null,
            (meta.tags ?? []).slice(0, 6).map((tag) => jsx.jsx('span', { style: T.chip(null), children: String(tag) }, String(tag))),
            meta.repo ? jsx.jsx('span', { style: { opacity: 0.7 }, children: String(meta.repo) }, 'repo') : null,
          ] }, 'sub'),
          jsx.jsx('div', { style: { ...T.sub, display: 'block', whiteSpace: 'pre-wrap', maxHeight: 96, overflow: 'auto' }, children: String(meta.description || t('card.ideaDetail.noBody')).slice(0, 400) }, 'body'),
          tasks.length
            ? jsx.jsxs('div', { style: { marginTop: 6 }, children: [
                jsx.jsx('div', { style: { ...T.sub, marginTop: 0 }, children: t('card.ideaDetail.tasks') }, 'h'),
                tasks.slice(0, 5).map((x) => jsx.jsxs('div', { style: T.row, children: [
                  jsx.jsx('span', { style: T.chip(null), children: String(x.status) }, 'st'),
                  jsx.jsx('span', { style: T.rowTitle, children: String(x.id) }, 'id'),
                ] }, String(x.id))),
              ] }, 'tasks')
            : null,
        ] }, 'body'),
      });
    }

    /** 任务卡 / 任务列表卡（aitm_task_start / aitm_task_status） */
    function TaskCard({ meta, t }) {
      if (Array.isArray(meta.items)) {
        return jsx.jsx(Card, {
          t,
          icon: 'IconQueueOutlineRegular',
          title: `${t('card.task.title')} · ${String(meta.items.length)}`,
          children: meta.items.length
            ? jsx.jsx('div', { children: meta.items.slice(0, 8).map((x) => jsx.jsxs('div', { style: T.row, children: [
                jsx.jsx('span', { style: T.chip(null), children: String(x.status) }, 'st'),
                jsx.jsx('span', { style: T.rowTitle, children: String(x.title ?? x.id) }, 't'),
                x.turns ? jsx.jsx('span', { style: { opacity: 0.6, flex: 'none' }, children: t('card.task.turns', { n: String(x.turns) }) }, 'turn') : null,
              ] }, String(x.id))) }, 'list')
            : jsx.jsx('div', { style: T.sub, children: t('card.task.empty') }, 'empty'),
        });
      }
      const task = meta.task ?? {};
      return jsx.jsx(Card, {
        t,
        icon: 'IconQueueOutlineRegular',
        title: String(task.title ?? task.id ?? t('card.task.title')),
        accent: true,
        children: jsx.jsxs('div', { children: [
          jsx.jsxs('div', { style: T.sub, children: [
            statusChip(null),
            jsx.jsx('span', { style: T.chip(null), children: String(task.status ?? '?') }, 'st'),
            task.turns ? jsx.jsx('span', { children: t('card.task.turns', { n: String(task.turns) }) }, 'turn') : null,
            task.adapterId ? jsx.jsx('span', { style: { opacity: 0.7 }, children: String(task.adapterId) }, 'adapter') : null,
          ] }, 'sub'),
          task.error ? jsx.jsx('div', { style: { ...T.sub, color: '#d1242f' }, children: String(task.error).slice(0, 300) }, 'err') : null,
        ] }, 'body'),
      });
    }

    /** 日历卡（aitm_calendar_day）：那天的想法 + 收藏 */
    function CalendarDayCard({ meta, t }) {
      const ideas = Array.isArray(meta.ideas) ? meta.ideas : [];
      const favs = Array.isArray(meta.favorites) ? meta.favorites : [];
      return jsx.jsx(Card, {
        t,
        icon: 'IconAlarmClockOutlineRegular',
        title: `${t('card.calendar.title')} · ${String(meta.day ?? '')}`,
        children: jsx.jsxs('div', { children: [
          jsx.jsx('div', { style: T.sub, children: t('card.calendar.month', { ideas: String(meta.monthIdeas ?? 0), favs: String(meta.monthFavorites ?? 0) }) }, 'month'),
          ideas.length || favs.length
            ? jsx.jsxs('div', { children: [
                ideas.slice(0, 6).map((i) => jsx.jsxs('div', { style: T.row, children: [
                  statusChip(i.status),
                  jsx.jsx('span', { style: T.rowTitle, children: String(i.title ?? i.id) }, 't'),
                ] }, `i-${String(i.id)}`)),
                favs.slice(0, 4).map((f, idx) => jsx.jsxs('div', { style: T.row, children: [
                  jsx.jsx('span', { style: T.chip(f.source), children: String(f.source ?? '收藏') }, 's'),
                  jsx.jsx('span', { style: T.rowTitle, children: String(f.title ?? '') }, 't'),
                ] }, `f-${String(idx)}`)),
              ] }, 'list')
            : jsx.jsx('div', { style: T.sub, children: t('card.calendar.nothing') }, 'empty'),
        ] }, 'body'),
      });
    }

    /** 仓库与工作区卡（aitm_repo_status） */
    function ReposCard({ meta, t }) {
      const repos = Array.isArray(meta.repos) ? meta.repos : [];
      return jsx.jsx(Card, {
        t,
        icon: 'IconBranchOutlineRegular',
        title: t('card.repos.title'),
        children: jsx.jsxs('div', { children: [
          jsx.jsxs('div', { style: T.sub, children: [
            t('card.repos.summary', {
              repos: String(repos.length),
              worktrees: String(meta.worktrees ?? 0),
              mb: String(Math.round((meta.totalKb ?? 0) / 1024)),
            }),
            meta.reclaimable ? jsx.jsx('span', { children: t('card.repos.reclaim', { n: String(meta.reclaimable) }) }, 'gc') : null,
          ] }, 'sum'),
          repos.slice(0, 6).map((r) => jsx.jsxs('div', { style: T.row, children: [
            jsx.jsx('span', { style: T.chip(null), children: String(r.worktrees ?? 0) }, 'n'),
            jsx.jsx('span', { style: T.rowTitle, children: String(r.name ?? r.path) }, 't'),
            r.active ? jsx.jsx('span', { style: { ...T.chip('developing'), flex: 'none' }, children: `${String(r.active)} 在跑` }, 'a') : null,
          ] }, String(r.id ?? r.name))),
        ] }, 'body'),
      });
    }

    /** 备份卡（aitm_backup_now） */
    function BackupCard({ meta, t }) {
      return jsx.jsx(Card, {
        t,
        icon: 'IconArchiveCheckOutlineRegular',
        title: t('card.backup.done', { mode: meta.mode === 'full' ? '全量' : '轻量' }),
        accent: true,
        children: jsx.jsxs('div', { style: T.sub, children: [
          jsx.jsx('span', { children: t('card.backup.files', { n: String(meta.files ?? 0) }) }, 'f'),
          jsx.jsx('span', { children: `${Math.round((meta.bytes ?? 0) / 1024)} KB` }, 'b'),
          meta.label ? jsx.jsx('span', { style: { opacity: 0.7 }, children: String(meta.label) }, 'l') : null,
          meta.deduped ? jsx.jsx('span', { style: { opacity: 0.7 }, children: t('card.backup.deduped') }, 'd') : null,
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
        case 'idea-detail':
          return IdeaDetailCard({ meta, t });
        case 'task':
        case 'task-list':
          return TaskCard({ meta, t });
        case 'calendar':
          return CalendarDayCard({ meta, t });
        case 'repos':
          return ReposCard({ meta, t });
        case 'backup':
          return BackupCard({ meta, t });
        default:
          return FallbackCard({ text, toolName, t });
      }
    }

    /** 我们注册了工具卡的工具名（keyed 槽的 key） */
    const CARD_TOOLS = [
      'aitm_health',
      'aitm_idea_list',
      'aitm_idea_get',
      'aitm_feed_today',
      'aitm_idea_create',
      'aitm_idea_set_status',
      'aitm_task_status',
      'aitm_task_start',
      'aitm_calendar_day',
      'aitm_repo_status',
      'aitm_backup_now',
    ];


    /* ─────────── 原生看板（不走 iframe） ─────────── */

    /**
     * 列序与文案**抄内核**（`src/shared/labels.ts` 的 IDEA_ORDER / IDEA_LABEL）：
     * 归档不进看板、受阻排在待验收之后。插件是独立包，不能 import 仓库源码，所以这里是副本 ——
     * 改内核那份时记得同步（verify-dsh 有断言钉住列序）。
     *
     * 写法注意：DSH 给的是 `react/jsx-runtime` 的 `jsx/jsxs`，签名是 **(type, props, key)** ——
     * 第三个参数是 key、不是 children！孩子必须写进 `props.children`（踩过一次：写成位置参数 →
     * 渲染出来是个空 div）。
     */
    const IDEA_ORDER = ['inbox', 'scoping', 'ready', 'developing', 'review', 'blocked', 'done'];
    const IDEA_LABEL = {
      zh: { inbox: '灵感箱', scoping: '梳理中', ready: '可开发', developing: '开发中', review: '待验收', blocked: '受阻', done: '已完成' },
      en: { inbox: 'Inbox', scoping: 'Scoping', ready: 'Ready', developing: 'Developing', review: 'Review', blocked: 'Blocked', done: 'Done' },
    };

    const BOARD = {
      wrap: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 12.5 },
      toolbar: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderBottom: '1px solid var(--dsh-color-border, #d8dae0)', flex: 'none', flexWrap: 'wrap' },
      input: {
        flex: 1,
        minWidth: 90,
        background: 'transparent',
        color: 'inherit',
        border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.35))',
        borderRadius: 6,
        padding: '2px 7px',
        fontSize: 12,
        outline: 'none',
      },
      select: {
        background: 'transparent',
        color: 'inherit',
        border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.35))',
        borderRadius: 6,
        padding: '1px 4px',
        fontSize: 12,
      },
      counts: { padding: '4px 10px 5px', opacity: 0.7, fontSize: 11.5, borderBottom: '1px solid var(--dsh-color-border, #d8dae0)', flex: 'none' },
      cols: { display: 'flex', gap: 6, padding: '6px 8px 8px', overflowX: 'auto', alignItems: 'flex-start', flex: 1, minHeight: 0, overflowY: 'auto' },
      col: (over) => ({
        flex: 'none',
        width: 172,
        background: over ? 'var(--dsh-color-fill, rgba(127,127,127,0.10))' : 'transparent',
        borderRadius: 8,
        padding: 4,
        minHeight: 40,
        border: `1px dashed ${over ? 'var(--dsh-color-border, rgba(127,127,127,0.6))' : 'transparent'}`,
      }),
      colHead: { display: 'flex', alignItems: 'center', gap: 5, padding: '2px 4px 6px' },
      card: (sel) => ({
        background: 'var(--dsh-color-fill, rgba(127,127,127,0.08))',
        border: `1px solid ${sel ? 'var(--dsh-color-accent, rgba(80,140,255,0.9))' : 'var(--dsh-color-border, rgba(127,127,127,0.22))'}`,
        borderRadius: 8,
        padding: '6px 7px',
        marginBottom: 5,
        cursor: 'pointer',
        userSelect: 'none',
      }),
      cardTitle: { display: 'flex', alignItems: 'flex-start', gap: 4, lineHeight: 1.35, wordBreak: 'break-word' },
      meta: { display: 'flex', alignItems: 'center', gap: 5, marginTop: 5, opacity: 0.75, fontSize: 11, flexWrap: 'wrap' },
      star: { border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0, flex: 'none', opacity: 0.85, fontSize: 13, lineHeight: 1 },
      link: { cursor: 'pointer', opacity: 0.75, flex: 'none' },
    };

    /** 按状态分桶（纯函数，verify 离线断言它）；列序里没有的状态（如 archived）不进看板 */
    function groupByStatus(ideas) {
      const out = {};
      for (const st of IDEA_ORDER) out[st] = [];
      for (const i of ideas ?? []) if (out[i.status]) out[i.status].push(i);
      return out;
    }

    const priText = (p) => (p === 'p0' ? 'P0' : p === 'p1' ? 'P1' : p === 'p2' ? 'P2' : p === 'p3' ? 'P3' : '');

    /** 相对时间（与桌面 `ui.tsx` 的 relTime 逐字一致 —— 同一条想法在两处不能显示成两个时间） */
    function relTime(ts) {
      if (!ts) return '—';
      const min = Math.floor((Date.now() - ts) / 60_000);
      if (min < 1) return '刚刚';
      if (min < 60) return `${String(min)} 分钟前`;
      const h = Math.floor(min / 60);
      if (h < 24) return `${String(h)} 小时前`;
      const d = Math.floor(h / 24);
      if (d < 30) return `${String(d)} 天前`;
      return new Date(ts).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
    }

    /** 小卡片（纯展示）：标题 / 正文一行 / 优先级 / 标签 / 任务数 / 仓库 / 相对时间 */
    function BoardCard(props) {
      const { idea, repo, taskCount, running, selected, onOpen, onStar, onDragStart, onDragEnd, t } = props;
      const pri = priText(idea.priority);
      const meta = [
        pri ? jsx.jsx('span', { children: pri }, 'pri') : null,
        ...(idea.tags ?? []).slice(0, 2).map((tag) => jsx.jsx('span', { children: `#${String(tag)}` }, String(tag))),
        jsx.jsx('span', { style: { flex: 1 } }, 'grow'),
        taskCount ? jsx.jsx('span', { style: { color: running ? 'var(--dsh-color-accent, #4a8cff)' : undefined }, children: `⌘ ${String(taskCount)}` }, 'tasks') : null,
        repo ? jsx.jsx('span', { children: repo }, 'repo') : null,
        jsx.jsx('span', { children: relTime(idea.updatedAt) }, 'time'),
      ].filter(Boolean);
      return jsx.jsx('article', {
        style: BOARD.card(selected),
        draggable: true,
        'data-idea': idea.id,
        onDragStart: (e) => {
          try {
            e.dataTransfer.setData('text/idea-id', idea.id);
            e.dataTransfer.effectAllowed = 'move';
          } catch {
            /* 某些环境拿不到 dataTransfer，靠 state 兜底 */
          }
          onDragStart?.(idea.id);
        },
        onDragEnd: () => onDragEnd?.(),
        onClick: () => onOpen?.(idea.id),
        children: [
          jsx.jsxs('div', { style: BOARD.cardTitle, children: [
            jsx.jsx('span', { style: { flex: 1 }, children: String(idea.title ?? '(无标题)') }, 'title'),
            jsx.jsx('button', {
              type: 'button',
              title: idea.starred ? t('board.unstar') : t('board.star'),
              style: BOARD.star,
              onClick: (e) => {
                e.stopPropagation();
                onStar?.(idea.id);
              },
              children: idea.starred ? '★' : '☆',
            }, 'star'),
          ] }, 'head'),
          idea.description
            ? jsx.jsx('div', { style: { opacity: 0.7, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: String(idea.description).slice(0, 60) }, 'desc')
            : null,
          jsx.jsx('div', { style: BOARD.meta, children: meta }, 'meta'),
        ].filter(Boolean),
      });
    }

    /** 一列（纯展示 + 拖放目标） */
    function BoardColumn(props) {
      const { status, ideas, repos, tasks, selected, onOpen, onStar, onDrop, onDragStart, onDragEnd, t } = props;
      const [over, setOver] = react.useState(false);
      const repoName = (id) => (id ? (repos.find((r) => r.id === id)?.name ?? t('board.repoGone')) : null);
      return jsx.jsxs('div', {
        style: BOARD.col(over),
        'data-col': status,
        onDragOver: (e) => {
          e.preventDefault();
          setOver(true);
        },
        onDragLeave: () => setOver(false),
        onDrop: (e) => {
          e.preventDefault();
          setOver(false);
          let id = null;
          try {
            id = e.dataTransfer.getData('text/idea-id');
          } catch {
            /* 见上 */
          }
          if (id) onDrop?.(id, status);
        },
        children: [
          jsx.jsxs('div', { style: BOARD.colHead, children: [
            jsx.jsx('span', { style: { fontWeight: 600 }, children: t(`board.col.${status}`) }, 'label'),
            jsx.jsx('span', { style: { opacity: 0.6 }, children: String(ideas.length) }, 'n'),
          ] }, 'head'),
          ideas.length
            ? jsx.jsx('div', {
                children: ideas.map((idea) =>
                  jsx.jsx(
                    BoardCard,
                    {
                      idea,
                      repo: repoName(idea.repoId),
                      taskCount: tasks.filter((x) => x.ideaId === idea.id).length,
                      running: tasks.some((x) => x.ideaId === idea.id && (x.status === 'running' || x.status === 'queued')),
                      selected: selected === idea.id,
                      onOpen,
                      onStar,
                      onDragStart,
                      onDragEnd,
                      t,
                    },
                    idea.id,
                  ),
                ),
              }, 'cards')
            : jsx.jsx('div', { style: { opacity: 0.5, textAlign: 'center', padding: '8px 2px' }, children: t('board.dropHere') }, 'empty'),
        ],
      });
    }

    /**
     * 原生看板（有数据的那一层）。
     *
     * 与桌面面板**同一份口径**：列序 / 文案抄 `src/shared/labels.ts`；筛选是**服务端按条件查**
     * （`idea.list` 带 q / status —— 不是前端过滤，桌面那边为这条踩过 bug）；
     * 计数永远取 `overview.get` 的全量（R7：筛选下生命周期计数不变）。
     * 拖拽改状态走 `idea.setStatus`（内核校验合法流转，非法流转把原因原样显示出来）。
     */
    function AitmBoard({ base, onOpenFull, initialIdea }) {
      const [q, setQ] = react.useState('');
      const [status, setStatus] = react.useState('all');
      const [data, setData] = react.useState({ loading: true, ideas: [], overview: null, repos: [], tasks: [], error: null });
      const [detail, setDetail] = react.useState(null); // {loading, id, meta?, error?}
      const [note, setNote] = react.useState(null);
      const qRef = react.useRef(q);
      qRef.current = q;
      const loadRef = react.useRef(null); // 给事件流用：不进依赖，免得一改筛选就重连

      const t = (k, vars) => String(zh[k] ?? en[k] ?? k).replace(/\{(\w+)\}/g, (m, n) => (vars && n in vars ? String(vars[n]) : m));

      const openDetail = react.useCallback(
        async (id) => {
          setDetail({ loading: true, id });
          try {
            const d = await postAction(base, 'idea.get', id);
            setDetail({ loading: false, id, meta: detailMeta(d) });
          } catch (err) {
            setDetail({ loading: false, id, error: String(err?.message ?? err) });
          }
        },
        [base],
      );

      const load = react.useCallback(
        async (opts = {}) => {
          if (!base) return;
          const useQ = opts.q ?? qRef.current;
          const useStatus = opts.status ?? status;
          setData((d) => ({ ...d, loading: true }));
          try {
            const [ideas, overview, repos, tasks] = await Promise.all([
              postAction(base, 'idea.list', { ...(useQ ? { q: useQ } : {}), ...(useStatus === 'all' ? {} : { status: useStatus }) }),
              postAction(base, 'overview.get', {}),
              postAction(base, 'repo.list', {}),
              postAction(base, 'task.list', {}),
            ]);
            setData({
              loading: false,
              ideas: Array.isArray(ideas) ? ideas : [],
              overview,
              repos: Array.isArray(repos) ? repos : [],
              tasks: Array.isArray(tasks) ? tasks : [],
              error: null,
            });
          } catch (err) {
            setData((d) => ({ ...d, loading: false, error: String(err?.message ?? err) }));
          }
        },
        [base, status],
      );

      react.useEffect(() => {
        void load();
      }, [load]);

      // 别处（原生日历、工具卡）点了某条想法 → 直接把它的详情摊开
      react.useEffect(() => {
        if (initialIdea) void openDetail(initialIdea);
      }, [initialIdea, openDetail]);

      loadRef.current = load;

      // 搜索框：停手 250ms 再查（服务端查询，见桌面那条「改条件就必须重查」的经验）
      react.useEffect(() => {
        const timer = setTimeout(() => void load({ q }), 250);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [q]);

      // 事件流：面板/工具那边改了数据（记想法、改状态、任务状态），这里自动跟一次（400ms 去抖）
      react.useEffect(() => {
        if (!base || typeof EventSource !== 'function') return undefined;
        let timer = null;
        let es = null;
        try {
          es = new EventSource(`${base}/api/events`);
          es.onmessage = () => {
            if (timer) return;
            timer = setTimeout(() => {
              timer = null;
              void loadRef.current?.();
            }, 400);
          };
        } catch {
          /* 不支持就算了，反正有「刷新」 */
        }
        return () => {
          if (timer) clearTimeout(timer);
          try {
            es?.close();
          } catch {
            /* 已关 */
          }
        };
      }, [base]);

      const changeStatus = async (id, to) => {
        const idea = data.ideas.find((i) => i.id === id);
        if (!idea || idea.status === to) return;
        setNote(null);
        try {
          await postAction(base, 'idea.setStatus', { id, status: to });
          await load();
        } catch (err) {
          // 内核拒绝非法流转时把原因**原样**给出来（别只说「失败了」）
          setNote(t('board.setFailed', { msg: String(err?.message ?? err) }));
        }
      };

      const toggleStar = async (id) => {
        try {
          await postAction(base, 'idea.toggleStar', id);
          await load();
        } catch (err) {
          setNote(String(err?.message ?? err));
        }
      };

      if (detail) {
        return jsx.jsxs('div', { style: BOARD.wrap, 'data-board': 'detail', children: [
          jsx.jsxs('div', { style: BOARD.toolbar, children: [
            jsx.jsx('a', { style: BOARD.link, onClick: () => setDetail(null), children: t('board.back') }, 'back'),
            jsx.jsx('span', { style: { flex: 1 } }, 'grow'),
            onOpenFull ? jsx.jsx('a', { style: BOARD.link, onClick: () => onOpenFull(detail.id), children: t('board.openFull') }, 'full') : null,
          ] }, 'bar'),
          detail.loading
            ? jsx.jsx('div', { style: { padding: 14, opacity: 0.8 }, children: t('board.detailLoading') }, 'loading')
            : detail.error
              ? jsx.jsx('div', { style: { padding: 14, opacity: 0.9 }, children: `${t('card.idea.failed')}：${detail.error}` }, 'err')
              : jsx.jsx('div', { style: { padding: '2px 6px 10px', overflowY: 'auto' }, children: jsx.jsx(IdeaDetailCard, { meta: detail.meta, t }) }, 'card'),
        ] });
      }

      const buckets = groupByStatus(data.ideas);
      const counts = data.overview?.counts ?? {};
      return jsx.jsxs('div', { style: BOARD.wrap, 'data-board': 'board', children: [
        jsx.jsxs('div', { style: BOARD.toolbar, children: [
          jsx.jsx('input', {
            style: BOARD.input,
            placeholder: t('board.search'),
            value: q,
            onChange: (e) => setQ(e.target.value),
            'data-board-search': '1',
          }, 'q'),
          jsx.jsxs('select', {
            style: BOARD.select,
            value: status,
            onChange: (e) => setStatus(e.target.value),
            'data-board-status': '1',
            children: [
              jsx.jsx('option', { value: 'all', children: t('board.all') }, 'all'),
              ...IDEA_ORDER.map((st) => jsx.jsx('option', { value: st, children: t(`board.col.${st}`) }, st)),
            ],
          }, 'st'),
          jsx.jsx('a', { style: BOARD.link, onClick: () => void load(), children: t('board.refresh') }, 'reload'),
        ] }, 'bar'),
        jsx.jsxs('div', { style: BOARD.counts, children: [
          jsx.jsx('span', { children: `${t('board.counts')}${IDEA_ORDER.map((st) => `${t(`board.col.${st}`)} ${String(counts[st] ?? 0)}`).join(' · ')}` }, 'counts'),
          data.overview && (data.overview.running || data.overview.queued)
            ? jsx.jsx('span', { style: { marginLeft: 6 }, children: `｜${t('board.running', { n: String(data.overview.running ?? 0), n2: String(data.overview.queued ?? 0) })}` }, 'run')
            : null,
          jsx.jsx('span', { style: { marginLeft: 6, opacity: 0.7 }, children: `｜${t('board.filteredNote')}` }, 'note'),
        ] }, 'counts'),
        note ? jsx.jsx('div', { style: { padding: '4px 10px', color: 'var(--dsh-color-danger, #d35)', fontSize: 11.5 }, 'data-board-note': '1', children: note }, 'note') : null,
        data.error ? jsx.jsx('div', { style: { padding: '6px 10px', opacity: 0.9 }, children: `${t('card.idea.failed')}：${data.error}` }, 'err') : null,
        jsx.jsxs('div', { style: BOARD.cols, children: [
          ...IDEA_ORDER.map((st) =>
            jsx.jsx(
              BoardColumn,
              {
                status: st,
                ideas: buckets[st] ?? [],
                repos: data.repos,
                tasks: data.tasks,
                selected: detail?.id ?? null,
                onOpen: (id) => void openDetail(id),
                onStar: (id) => void toggleStar(id),
                onDrop: (id, to) => void changeStatus(id, to),
                onDragStart: () => {},
                onDragEnd: () => {},
                t,
              },
              st,
            ),
          ),
          data.loading && !data.ideas.length ? jsx.jsx('div', { style: { padding: 10, opacity: 0.7, flex: 'none' }, children: t('board.loading') }, 'loading') : null,
          !data.loading && !data.ideas.length && !data.error ? jsx.jsx('div', { style: { padding: 10, opacity: 0.7, flex: 'none' }, children: t('board.empty') }, 'empty') : null,
        ].filter(Boolean) }, 'cols'),
      ] });
    }

    /** `idea.get` 的返回 → 详情卡的 meta（与 aitm_idea_get 的 presentationMeta 同形，直接复用那张卡） */
    function detailMeta(d) {
      const idea = d?.idea ?? {};
      return {
        kind: 'idea-detail',
        id: idea.id,
        title: idea.title,
        status: idea.status,
        tags: idea.tags ?? [],
        priority: idea.priority ?? null,
        description: idea.description ?? '',
        spec: idea.spec ? String(idea.spec) : null,
        repo: d?.repo?.name ?? null,
        tasks: (d?.tasks ?? []).slice(0, 8).map((x) => ({ id: x.id, status: x.status, turns: x.turns ?? 0 })),
      };
    }


    /* ─────────── 原生日历（不走 iframe，直接是 DSH 里的 React 组件） ─────────── */

    /** 一周从周一开始（与面板/日历页同口径，见 src/shared/calendar.ts） */
    const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

    const dayKeyLocal = (ts) => {
      const d = new Date(ts);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    /** 固定 6 行 × 7 列（42 格），周一起排；`month` 0–11 */
    function monthGridDays(year, month, today) {
      const firstDow = (new Date(year, month, 1).getDay() + 6) % 7;
      const start = new Date(year, month, 1 - firstDow);
      const todayKey = dayKeyLocal(today);
      const out = [];
      for (let i = 0; i < 42; i++) {
        const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        const key = dayKeyLocal(d.getTime());
        out.push({ key, date: d.getTime(), day: d.getDate(), inMonth: d.getFullYear() === year && d.getMonth() === month, isToday: key === todayKey });
      }
      return out;
    }

    const shiftMonth = (year, month, delta) => {
      const d = new Date(year, month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    };
    const monthLabel = (y, m) => `${y} 年 ${m + 1} 月`;
    const dayLabel = (ts) => {
      const d = new Date(ts);
      return `${d.getMonth() + 1} 月 ${d.getDate()} 日 周${WEEKDAYS[(d.getDay() + 6) % 7]}`;
    };

    /** 按天分组（口径同上） */
    function groupByDayLocal(items, ts) {
      const out = new Map();
      for (const it of items) {
        const key = dayKeyLocal(ts(it));
        const list = out.get(key);
        if (list) list.push(it);
        else out.set(key, [it]);
      }
      return out;
    }

    /** 调一次后端 action（浏览器 → 回环 HTTP；跨源但服务端给了 CORS *） */
    async function postAction(base, action, payload) {
      const res = await fetch(`${base}/api/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      });
      const env = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      if (!env?.ok) throw new Error(env?.error ?? `HTTP ${res.status}`);
      return env.data;
    }

    const CAL = {
      wrap: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 12.5 },
      head: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderBottom: '1px solid var(--dsh-color-border, #d8dae0)', flex: 'none' },
      nav: { border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.35))', background: 'transparent', color: 'inherit', borderRadius: 6, cursor: 'pointer', padding: '1px 7px', fontSize: 12 },
      month: { fontWeight: 600 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, padding: '6px 8px 0', flex: 'none' },
      dow: { textAlign: 'center', opacity: 0.6, fontSize: 11, padding: '2px 0' },
      cell: (inMonth, isToday, selected) => ({
        position: 'relative',
        textAlign: 'center',
        padding: '4px 0 2px',
        borderRadius: 6,
        cursor: 'pointer',
        border: '1px solid transparent',
        opacity: inMonth ? 1 : 0.35,
        background: selected ? 'rgba(56,139,253,0.18)' : 'transparent',
        borderColor: isToday ? 'var(--dsh-color-border, rgba(127,127,127,0.5))' : 'transparent',
        fontWeight: isToday ? 600 : 400,
      }),
      dots: { display: 'flex', justifyContent: 'center', gap: 3, height: 6, marginTop: 1 },
      dot: { width: 5, height: 5, borderRadius: 999, flex: 'none' },
      detail: { flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 10px 12px', borderTop: '1px solid var(--dsh-color-border, #d8dae0)' },
      sectionTitle: { opacity: 0.65, margin: '6px 0 4px' },
      item: { display: 'flex', gap: 6, alignItems: 'baseline', marginBottom: 3, cursor: 'pointer', minWidth: 0 },
      itemTitle: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      empty: { opacity: 0.65, padding: '10px 0' },
    };

    /**
     * 月历网格（**纯展示**：只吃 props，不抓数据）—— 这样 verify 能离线渲染断言，
     * 不必在沙箱里跑浏览器。
     */
    function CalendarGrid({ days, ideasByDay, favsByDay, selected, onPick, t }) {
      const dot = (n, color) => (n > 0 ? jsx.jsx('span', { style: { ...CAL.dot, background: color } }, 'd') : null);
      return jsx.jsxs('div', { children: [
        jsx.jsx('div', { style: CAL.grid, children: WEEKDAYS.map((w) => jsx.jsx('div', { style: CAL.dow, children: w }, w)) }, 'dow'),
        jsx.jsx('div', { style: CAL.grid, 'data-calendar': 'grid', children: days.map((d) => {
          const ni = (ideasByDay.get(d.key) ?? []).length;
          const nf = (favsByDay.get(d.key) ?? []).length;
          return jsx.jsxs(
            'div',
            {
              style: CAL.cell(d.inMonth, d.isToday, d.key === selected),
              title: `${d.key}：想法 ${ni} · 收藏 ${nf}`,
              onClick: () => onPick(d),
              'data-day': d.key,
              children: [
                jsx.jsx('div', { children: String(d.day) }, 'n'),
                jsx.jsx('div', { style: CAL.dots, children: [dot(ni, '#388bfd'), dot(nf, '#bb8009')] }, 'dots'),
              ],
            },
            d.key,
          );
        }) }, 'grid'),
      ] });
    }

    /** 日历容器：抓数据（想法 + 收藏）→ 网格 + 当天明细 */
    function AitmCalendar({ base, onOpenIdea }) {
      const [data, setData] = react.useState({ loading: false, ideas: [], favorites: [], error: null });
      const now = Date.now();
      const [cursor, setCursor] = react.useState(() => ({ year: new Date(now).getFullYear(), month: new Date(now).getMonth() }));
      const [selected, setSelected] = react.useState(() => dayKeyLocal(Date.now()));
      const load = react.useCallback(async () => {
        if (!base) return;
        setData((d) => ({ ...d, loading: true }));
        try {
          const ideas = (await postAction(base, 'idea.list', {})) ?? [];
          let favorites = [];
          try {
            const snap = await postAction(base, 'feed.get', {});
            favorites = Array.isArray(snap?.favorites) ? snap.favorites : [];
          } catch {
            /* 没抓过新闻就没有收藏那一半，不该让日历整个失败 */
          }
          setData({ loading: false, ideas, favorites, error: null });
        } catch (err) {
          setData({ loading: false, ideas: [], favorites: [], error: String(err?.message ?? err) });
        }
      }, [base]);

      react.useEffect(() => {
        void load();
      }, [load]);

      // 事件流：面板/工具那边改了数据（记想法、收藏），这里自动跟一次
      react.useEffect(() => {
        if (!base || typeof EventSource !== 'function') return undefined;
        let timer = null;
        let es = null;
        try {
          es = new EventSource(`${base}/api/events`);
          es.onmessage = () => {
            if (timer) return;
            timer = setTimeout(() => {
              timer = null;
              void load();
            }, 400);
          };
        } catch {
          /* 不支持就算了，反正有「刷新」 */
        }
        return () => {
          if (timer) clearTimeout(timer);
          try {
            es?.close();
          } catch {
            /* 已关 */
          }
        };
      }, [base, load]);

      const ideasByDay = react.useMemo(() => groupByDayLocal(data.ideas, (i) => i.createdAt ?? 0), [data.ideas]);
      const favsByDay = react.useMemo(() => groupByDayLocal(data.favorites, (f) => f.savedAt ?? 0), [data.favorites]);
      const days = react.useMemo(() => monthGridDays(cursor.year, cursor.month, Date.now()), [cursor.year, cursor.month]);
      const prefix = `${String(cursor.year)}-${String(cursor.month + 1).padStart(2, '0')}`;
      const monthIdeas = data.ideas.filter((i) => dayKeyLocal(i.createdAt ?? 0).startsWith(prefix)).length;
      const monthFavs = data.favorites.filter((f) => dayKeyLocal(f.savedAt ?? 0).startsWith(prefix)).length;
      const sel = days.find((d) => d.key === selected);
      const selIdeas = [...(ideasByDay.get(selected) ?? [])].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      const selFavs = [...(favsByDay.get(selected) ?? [])].sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
      const t = (k, vars) => String(zh[k] ?? en[k] ?? k).replace(/\{(\w+)\}/g, (m, n) => (vars && n in vars ? String(vars[n]) : m));

      const pick = (d) => {
        setSelected(d.key);
        if (!d.inMonth) {
          const x = new Date(d.date);
          setCursor({ year: x.getFullYear(), month: x.getMonth() });
        }
      };

      return jsx.jsxs('div', { className: 'aitm-calendar', 'data-plugin': 'dsh-plugin-aitm', style: CAL.wrap, children: [
        jsx.jsxs('div', { style: CAL.head, children: [
          jsx.jsx('button', { type: 'button', style: CAL.nav, onClick: () => setCursor((c) => shiftMonth(c.year, c.month, -1)), 'aria-label': '上个月', children: '‹' }, 'prev'),
          jsx.jsx('span', { style: CAL.month, children: monthLabel(cursor.year, cursor.month) }, 'm'),
          jsx.jsx('button', { type: 'button', style: CAL.nav, onClick: () => { const n = new Date(); setCursor({ year: n.getFullYear(), month: n.getMonth() }); setSelected(dayKeyLocal(n.getTime())); }, children: '今天' }, 'today'),
          jsx.jsx('button', { type: 'button', style: CAL.nav, onClick: () => setCursor((c) => shiftMonth(c.year, c.month, 1)), 'aria-label': '下个月', children: '›' }, 'next'),
          jsx.jsx('span', { style: { marginLeft: 'auto', opacity: 0.7 }, children: t('card.calendar.month', { ideas: String(monthIdeas), favs: String(monthFavs) }) }, 'sum'),
          jsx.jsx('a', { style: { ...LINK, marginLeft: 8 }, onClick: () => void load(), children: data.loading ? '…' : '刷新' }, 'reload'),
        ] }, 'head'),
        jsx.jsx(CalendarGrid, { days, ideasByDay, favsByDay, selected, onPick: pick, t }, 'grid'),
        jsx.jsxs('div', { style: CAL.detail, children: [
          jsx.jsx('div', { style: { fontWeight: 600 }, children: sel ? dayLabel(sel.date) : selected }, 'day'),
          data.error ? jsx.jsx('div', { style: { color: '#d1242f', marginTop: 6 }, children: `读数据失败：${data.error}` }, 'err') : null,
          selIdeas.length
            ? jsx.jsxs('div', { children: [
                jsx.jsx('div', { style: CAL.sectionTitle, children: `想法 ${selIdeas.length}` }, 'h'),
                selIdeas.map((i) => jsx.jsxs('div', {
                  style: CAL.item,
                  onClick: () => onOpenIdea?.(i.id),
                  title: '在面板里打开',
                  children: [
                    statusChip(i.status),
                    jsx.jsx('span', { style: CAL.itemTitle, children: String(i.title ?? i.id) }, 't'),
                  ],
                }, String(i.id))),
              ] }, 'ideas')
            : null,
          selFavs.length
            ? jsx.jsxs('div', { children: [
                jsx.jsx('div', { style: CAL.sectionTitle, children: `收藏 ${selFavs.length}` }, 'h'),
                selFavs.map((f, idx) => jsx.jsxs('div', { style: CAL.item, title: f.url ?? '', children: [
                  jsx.jsx('span', { style: T.chip(f.source), children: String(f.source ?? '收藏') }, 's'),
                  jsx.jsx('span', { style: CAL.itemTitle, children: String(f.title ?? '') }, 't'),
                ] }, `f-${String(idx)}`)),
              ] }, 'favs')
            : null,
          !selIdeas.length && !selFavs.length && !data.error
            ? jsx.jsx('div', { style: CAL.empty, children: data.loading ? '读取中…' : t('card.calendar.nothing') }, 'empty')
            : null,
        ] }, 'detail'),
      ] });
    }

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
      /** 原生日历点想法 → 原生看板直接把详情摊开（不再切 iframe） */
      const [boardIdea, setBoardIdea] = react.useState(null);
      /** 「在完整面板里打开」→ iframe 带 id（面板支持 `&idea=<id>` 深链，那边有对话/差异/属性） */
      const [embedIdea, setEmbedIdea] = react.useState(null);
      const ready = Boolean(cfg.base) && cfg.health?.ok;
      // 后端身份：老实例（apiRev 不够）不能装作可用 —— 否则工具会报「未知接口：feed.get」
      const rev = cfg.identity?.apiRev ?? cfg.health?.apiRev ?? null;
      const stale = cfg.error ? /旧版|apiRev/.test(cfg.error) : rev !== null && rev < (cfg.apiRevRequired ?? 2);
      const src = cfg.base
        ? `${cfg.base}/?embed=1&view=${encodeURIComponent(view)}${embedIdea ? `&idea=${encodeURIComponent(embedIdea)}` : ''}`
        : '';
      const tab = (id, text) =>
        jsx.jsx(
          'a',
          {
            style: { cursor: 'pointer', textDecoration: 'none', opacity: view === id ? 1 : 0.55, fontWeight: view === id ? 600 : 400, fontSize: 12 },
            onClick: () => {
              // 切页签 = 收回「深链到 iframe 的那条」；离开看板也清掉它那条深链
              setEmbedIdea(null);
              if (id !== 'board') setBoardIdea(null);
              setView(id);
            },
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
                  jsx.jsx(
                    'span',
                    {
                      style: DOT(ready),
                      title: `${ready ? '后端正常' : '后端未就绪'}${cfg.clientRev ? ` · client.js rev ${cfg.clientRev}` : ''}`,
                    },
                    'dot',
                  ),
                  tab('board', '看板'),
                  tab('calendar', '日历'),
                  tab('feed', '合集'),
                  jsx.jsx('a', { style: LINK, onClick: () => { setNonce((n) => n + 1); reload(); }, children: '刷新' }, 'reload'),
                  jsx.jsx('a', { style: { ...LINK, marginLeft: 10 }, target: '_blank', rel: 'noreferrer', href: cfg.base ?? '#', children: '新窗口' }, 'open'),
                ],
              },
              'bar',
            ),
            ready && view === 'board' && !embedIdea
              ? // 看板也是**原生 React**（M3：逐页搬家）——列序/文案/服务端筛选都与桌面一致，
                // 点卡片在原地摊开详情；要对话/差异/属性再走「在完整面板里打开」的 iframe。
                jsx.jsx(AitmBoard, { base: cfg.base, initialIdea: boardIdea, onOpenFull: (id) => setEmbedIdea(id) })
              : ready && view === 'calendar'
              ? // 日历同样是原生 React：在 DSH 右侧栏里更跟手、跟主题一致；点想法回看板摊开详情。
                jsx.jsx(AitmCalendar, { base: cfg.base, onOpenIdea: (id) => { setBoardIdea(id); setView('board'); } })
              : ready
              ? jsx.jsx('iframe', {
                  key: `${nonce}-${view}-${embedIdea ?? ''}`,
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
          // 面板产物指纹：改了 client.js 却没生效时，拿 DSH 网络面板里 `&rev=` 的值和这里比一下
          row('面板', cfg.pluginVersion ? `${cfg.pluginVersion}${cfg.clientRev ? ` · client.js rev ${cfg.clientRev}` : ''}` : '—'),
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
    exports.__components = { AitmPanel, AitmTabTitle, AitmSection, AitmToolCard, AitmCalendar, CalendarGrid, AitmBoard, BoardColumn, BoardCard };
    /** 给 verify 用：日历的纯计算（网格/分组），不依赖 React */
    exports.__calendarHelpers = { monthGridDays, shiftMonth, dayKeyLocal, groupByDayLocal, monthLabel, dayLabel, postAction };
    /** 给 verify 用：看板的列序 / 分桶 / 相对时间（纯计算，不依赖 React） */
    exports.__boardHelpers = { IDEA_ORDER, IDEA_LABEL, groupByStatus, relTime };
    /** 给 verify 用：客户端半边依赖的服务名（每个都必须有提供者，否则整块 pending → 白屏） */
    exports.__clientInject = [...inject];
    /** 给 verify 用：卡片注册了哪些工具名 */
    exports.__cardTools = CARD_TOOLS;
    return module.exports;
  },
});
