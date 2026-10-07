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

    /**
     * 触屏（手机 / 平板）判定：DSH 自己在 `@media (pointer:coarse)` 里把点按目标抬到 44px
     * （见 dsh-client-ui-\* 的样式），我们的内联样式进不去媒体查询，所以在这里判一次。
     * 只影响**点按面积**（按钮内边距、最小高度），不改布局与文案。
     * 离线渲染 / jsdom 里没有 matchMedia → 当作非触屏（这也是桌面端的真实取值）。
     */
    const COARSE_POINTER = (() => {
      try {
        return typeof globalThis.matchMedia === 'function' && Boolean(globalThis.matchMedia('(pointer: coarse)')?.matches);
      } catch {
        return false;
      }
    })();
    /**
     * 从 resource timing 的条目里认出「**本页实际加载的** client.js rev」。
     *
     * 为什么需要：改了 client.js 之后，最常见的假故障是「浏览器还在跑旧代码」（没 pull / DSH 没重启 /
     * 装了另一份插件）—— 这时服务端看到的是新文件，页面跑的却是旧的，看板样式之类的改动就「不生效」。
     * 有了这个值，设置节里能直接对上：本页 rev ≠ 服务端 rev ⇒ 页面上是旧代码。
     *
     * 只认**单一 id**那种 URL（`/plugins/??<pkg>/client.js&rev=xxx`）：多个插件合并成一个 combo 时，
     * URL 上的 rev 是整包的组合 rev，不是我们这一份的，宁可返回 null 也不误报。纯函数，便于单测。
     */
    function loadedClientRev(entries) {
      try {
        // **从后往前找**：DSH 热更新（HMR）换过一次模块之后，同一个 client.js 会有多条记录
        // （每条一个 rev），先加载的那条是旧的。用户真机就踩过：面板是新代码，这行却读到旧 rev。
        const url = loadedClientScriptUrl(entries);
        return url ? (/[?&]rev=([0-9a-zA-Z]{6,})/.exec(url)?.[1] ?? null) : null;
      } catch {
        return null;
      }
    }

    /** 本页**最后一次**加载的 client.js 的完整 URL（给内容校验用）；认不出返回 null */
    function loadedClientScriptUrl(entries) {
      try {
        const list = entries ?? [];
        for (let i = list.length - 1; i >= 0; i -= 1) {
          const url = String(list[i]?.name ?? '');
          const m = /\/plugins\/\?\?([^&]*)&rev=[0-9a-zA-Z]{6,}/.exec(url);
          if (!m) continue;
          const ids = m[1];
          if (!ids.endsWith('/client.js')) continue; // 只要脚本本体（sourcemap、chunk 之类都不算）
          if (ids.includes(',')) continue; // 多插件合并的 combo：rev 是整包的，不是我们这一份的
          return url;
        }
        return null;
      } catch {
        return null;
      }
    }

    /** 本页实际加载的脚本 URL（浏览器里读一次；离线渲染 / jsdom 里没有 performance 就返回 null） */
    function loadedScriptUrlHere() {
      try {
        if (typeof globalThis.performance?.getEntriesByType !== 'function') return null;
        return loadedClientScriptUrl(globalThis.performance.getEntriesByType('resource'));
      } catch {
        return null;
      }
    }

    /**
     * 判定「本页跑的代码 == 磁盘上那份」。
     *
     * rev 是**文件元数据**（mtime/ctime/size）的哈希，DSH 只在登记/热更那一刻算一次：
     * 机器间不同步（pull 时间不同就不同）、文件被 touch 一下就变（哪怕字节没变）、
     * 页面被 HMR 就地换过时资源表里还留着旧记录 —— 所以 rev 只能当**快判**，不当定论。
     * 真定论用内容 sha1（只看字节）：两边都有就用它。
     */
    function clientVerdict({ serverRev, pageRev, serverSha, pageSha }) {
      if (serverSha && pageSha) return serverSha === pageSha ? 'ok' : 'stale';
      if (serverRev && pageRev) return serverRev === pageRev ? 'ok' : 'stale';
      return 'unknown';
    }

    /** 浏览器端 sha1 前 N 位（crypto.subtle 拿不到就返回 null：不猜） */
    async function sha1PrefixHex(buf, n = 12) {
      try {
        const subtle = globalThis.crypto?.subtle;
        if (!subtle || !buf) return null;
        const digest = await subtle.digest('SHA-1', buf);
        return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, n);
      } catch {
        return null;
      }
    }

    /** 触屏上给点按目标加的最小尺寸（非触屏是空对象，样式逐字不变） */
    const TAP = COARSE_POINTER ? { minHeight: 30, minWidth: 30 } : {};
    const TAP_WIDE = COARSE_POINTER ? { minHeight: 30, paddingLeft: 8, paddingRight: 8 } : {};

    /**
     * 窄容器（手机）判定：只用来定看板列宽 —— 窄屏一列占满大半（露下一列示意可横滑）。
     * 用视口宽度当面板宽度的近似：手机上 DSH 的面板就是整屏；桌面端不匹配（列宽保持 172）。
     * 同样是**加载时算一次**，改窗口大小不重算（真机验收记得重载页面，见 TESTING M65）。
     */
    const NARROW_PANEL = (() => {
      try {
        return typeof globalThis.matchMedia === 'function' && Boolean(globalThis.matchMedia('(max-width: 520px)')?.matches);
      } catch {
        return false;
      }
    })();

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
      'card.task.st.queued': '排队中',
      'card.task.st.running': '执行中',
      'card.task.st.waiting_input': '等你回复',
      'card.task.st.succeeded': '已完成',
      'card.task.st.failed': '失败',
      'card.task.st.cancelled': '已取消',
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
      /* 原生合集（不走 iframe 的那块；格式化口径抄 src/shared/feed-format.ts） */
      'feed.title': '新闻合集',
      'feed.updatedAt': '更新于 {t}',
      'feed.never': '还没抓过',
      'feed.total': '· {n} 条',
      'feed.refresh': '刷新',
      'feed.refreshing': '抓取中…',
      'feed.progress': '正在抓取热榜…',
      'feed.progressHint': '首次抓两个源大约 5–15 秒，可以先看已有的数据',
      'feed.disabled': '新闻合集已关闭 —— 在「设置 → 新闻合集」里打开后，这里会显示 GitHub 与 B站热榜。',
      'feed.loadFailed': '没取到合集数据：{msg}',
      'feed.retry': '重试',
      'feed.jump': '跳到{label}，共 {n} 条',
      'feed.collapseAll': '全部收起',
      'feed.expandAll': '全部展开',
      'feed.collapse': '收起这一块',
      'feed.expand': '展开这一块',
      'feed.state.busy': '抓取中…',
      'feed.state.ok': '正常',
      'feed.state.bad': '异常',
      'feed.state.never': '未抓取',
      'feed.failed': '{title}刷新失败',
      'feed.staleHint': '；下面显示的还是 {t} 抓到的数据（没有清空）',
      'feed.retryOne': '只重试{name}',
      'feed.block.github': 'GitHub 热榜',
      'feed.block.bilibili': 'B站热榜',
      'feed.block.favorites': '我的收藏',
      'feed.trendBuilding': '趋势分积累中（第 {n}/7 天，满 3 天启用趋势排序）',
      'feed.zoneBadge': '类别：{zones} · 关注 UP {ups}',
      'feed.zoneCount': '{n} 个分区',
      'feed.zoneNone': '未选',
      'feed.upFailed': '{n} 个关注 UP 抓取失败',
      'feed.lastFailed': '上次抓取失败：{msg}。',
      'feed.biliFooter': '数据来自 B站公开接口；一直「网络错误 / 风控」多半是网络环境问题（设置 → 新闻合集 里有「连接测试」，必要时填 SESSDATA）。关注的 UP 在设置里贴链接添加。',
      'feed.tab.today': '今日新发现',
      'feed.tab.week': '近 7 日持续上升',
      'feed.tab.month': '近 30 日持续上升',
      'feed.tab.new': '最近新建',
      'feed.tab.ups': '关注 UP',
      'feed.tab.ai': 'AI 相关',
      'feed.tab.hot': '全站热门',
      'feed.hint.today': '当日 trending 里命中 AI 关键词的模型 / 工具 / 技能',
      'feed.hint.trend': '上榜持续性 × 名次 × star 增速',
      'feed.hint.week': '趋势分积累中，先展示 GitHub 官方 weekly 榜',
      'feed.hint.month': '窗口拉长到 30 天',
      'feed.hint.new': '最近 7 天新建、star 涨得快（Search API）',
      'feed.hint.ups': '你订阅的 UP 主最新投稿，按发布时间倒序（每人最多 10 条）',
      'feed.hint.ai': 'B站没有 AI 分区，这一栏按关键词跨分区过滤',
      'feed.hint.hot': '综合热门（全站）',
      'feed.hint.zone': '官方分区榜',
      'feed.empty': '这一类暂无条目（源可能被限流，或这段时间没有命中）。',
      'feed.emptyGithub': '这一类暂无条目（源可能被限流，或这段时间没有命中）。',
      'feed.emptyBili': '这一类暂无条目（源可能被限流，或这段时间没有命中）。',
      'feed.favTotal': '共 {n} 条',
      'feed.favAll': '全部',
      'feed.favHint': '收藏的是条目快照：热榜换过几轮之后，这里的内容、链接和当时的数据都还在。已隐藏 {hidden} 条 —— 想恢复去「设置 → 新闻合集 → 已隐藏的条目」。',
      'feed.favEmpty': '还没有收藏：在热榜卡片右下角点 ★，就算这条掉出热榜，也能在这里找回来。',
      'feed.favEmptySource': '这个来源还没有收藏。',
      'feed.savedAt': '收藏于 {t}',
      'feed.open': '打开原文',
      'feed.star': '收藏（热榜换掉也找得到）',
      'feed.unstar': '取消收藏',
      'feed.hide': '不看它（从热榜隐藏）',
      'feed.openIdea': '已记录 → 打开想法',
      'feed.record': '以此内容记录想法',
      'feed.prefill': '改一改再记',
      'feed.starred': '已收藏（热榜换掉也找得到）',
      'feed.unstarred': '已取消收藏',
      'feed.hidden': '已隐藏：这条不会再出现在热榜里（想恢复：设置 → 新闻合集 → 已隐藏的条目）',
      'feed.recorded': '已记录为想法',
      'feed.alreadyRecorded': '这条已经记录过了',
      'feed.prefilled': '已记进想法箱：{id}',
      'feed.refreshFailed': '刷新失败：{msg}',
      'feed.hideTitle': '不再显示这一条？',
      'feed.hideBody': '它会从 GitHub / B站 热榜、「关注 UP」和收藏里一起消失（收藏记录本身不删，恢复后还在）。隐藏是永久的，想找回来：设置 → 新闻合集 → 已隐藏的条目。',
      'feed.hideConfirm': '不再显示',
      'feed.cancel': '取消',
      'feed.prefillTitle': '记录这条想法（可以先改）',
      'feed.prefillTags': '标签（空格分隔）',
      'feed.prefillSave': '记录想法',
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
      'board.moveTo': '改状态：',
      'board.tasks': '任务（点「继续」在原 worktree 上接着干；「重试」＝同指令新起一条）',
      'board.taskFollow': '继续',
      'board.taskRetry': '重试',
      'board.taskFollowHint': '接着干：在这个任务的 worktree 上追加一条指令（同一会话继续）',
      'board.taskRetryHint': '重试：用同样的指令**新起一条任务**（新 worktree，从基线开始；旧现场保留）',
      'board.taskSend': '发送',
      'board.taskCancel': '取消',
      'board.taskQueued': '已排入队列，接着干。进展在完整面板（或对话里问「任务怎么样了」）看。',
      'board.taskQueuedRetry': '已按原指令新起一条任务。',
      'board.taskBlocked': '这个任务正在跑（{st}），先等它停或中断',
      'board.taskActive': '进行中',
      'board.taskInterrupted': '被中断：{msg}',
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
      // 验收（M3：原生看板里也能验收；写工具 aitm_task_accept 的卡片文案同源）
      'board.accept': '验收并合并',
      'board.acceptOnly': '只记验收',
      'board.acceptAgain': '重新核对（已合并）',
      'board.acceptAck': '验证没过也要合',
      'board.accepting': '验收中…',
      'board.verifyOk': '验证通过',
      'board.verifyFail': '验证没过',
      'board.couldNotAccept': '没验收成：{msg}',
      'card.accept.merged': '已合并',
      'card.accept.recorded': '已记验收（未合并）',
      'card.accept.needsAck': '验证没过 —— 要人勾「验证没过也要合」才能继续',
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
      'card.task.st.queued': 'Queued',
      'card.task.st.running': 'Running',
      'card.task.st.waiting_input': 'Waiting for you',
      'card.task.st.succeeded': 'Succeeded',
      'card.task.st.failed': 'Failed',
      'card.task.st.cancelled': 'Cancelled',
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
      // 合集（M3 原生第三页；卡片上的事实与桌面 FeedView 逐字一致，verify-dsh 拿内核文件比对）
      'feed.title': 'Feed',
      'feed.updatedAt': 'Updated {t}',
      'feed.never': 'Never fetched',
      'feed.total': '· {n} items',
      'feed.refresh': 'Refresh',
      'feed.refreshing': 'Fetching…',
      'feed.progress': 'Fetching the boards…',
      'feed.progressHint': 'First fetch takes ~5–15s; existing data stays visible',
      'feed.disabled': 'Feed is off — turn it on under Settings → Feed to see GitHub & Bilibili here.',
      'feed.loadFailed': 'Could not load the feed: {msg}',
      'feed.retry': 'Retry',
      'feed.jump': 'Jump to {label} ({n})',
      'feed.collapseAll': 'Collapse all',
      'feed.expandAll': 'Expand all',
      'feed.collapse': 'Collapse this block',
      'feed.expand': 'Expand this block',
      'feed.state.busy': 'Fetching…',
      'feed.state.ok': 'OK',
      'feed.state.bad': 'Error',
      'feed.state.never': 'Not fetched',
      'feed.failed': '{title} refresh failed',
      'feed.staleHint': '; still showing data fetched {t} (nothing was cleared)',
      'feed.retryOne': 'Retry{name} only',
      'feed.block.github': 'GitHub trending',
      'feed.block.bilibili': 'Bilibili trending',
      'feed.block.favorites': 'My favorites',
      'feed.trendBuilding': 'Building trend score (day {n}/7; trend ranking after 3 days)',
      'feed.zoneBadge': 'Zones: {zones} · creators {ups}',
      'feed.zoneCount': '{n} zones',
      'feed.zoneNone': 'none',
      'feed.upFailed': '{n} followed creators failed',
      'feed.lastFailed': 'Last fetch failed: {msg}. ',
      'feed.biliFooter': 'Data comes from public Bilibili endpoints; recurring errors are usually network/anti-bot (Settings → Feed has a connection test; SESSDATA if needed). Add creators by pasting their space links in Settings.',
      'feed.tab.today': 'New today',
      'feed.tab.week': 'Rising (7d)',
      'feed.tab.month': 'Rising (30d)',
      'feed.tab.new': 'New repos',
      'feed.tab.ups': 'Creators',
      'feed.tab.ai': 'AI',
      'feed.tab.hot': 'Popular',
      'feed.hint.today': 'Today trending hits for AI keywords',
      'feed.hint.trend': 'Persistence × rank × star velocity',
      'feed.hint.week': 'Trend score still building; showing GitHub weekly',
      'feed.hint.month': 'Same, over 30 days',
      'feed.hint.new': 'Created in the last 7 days and gaining stars fast',
      'feed.hint.ups': 'Latest uploads from the creators you follow, newest first (max 10 each)',
      'feed.hint.ai': 'No AI zone on Bilibili — this filters all zones by keywords',
      'feed.hint.hot': 'Popular (site-wide)',
      'feed.hint.zone': 'Official zone ranking',
      'feed.empty': 'Nothing here yet (rate-limited, or no hits this round).',
      'feed.emptyGithub': 'Nothing here yet (rate-limited, or no hits this round).',
      'feed.emptyBili': 'Nothing here yet (rate-limited, or no hits this round).',
      'feed.favTotal': '{n} saved',
      'feed.favAll': 'All',
      'feed.favHint': 'Favorites keep an item snapshot: content, link and metrics stay after the board rotates. {hidden} hidden — restore under Settings → Feed.',
      'feed.favEmpty': 'No favorites yet: hit ★ on a card — it stays here even after it drops off the board.',
      'feed.favEmptySource': 'No favorites from this source yet.',
      'feed.savedAt': 'Saved {t}',
      'feed.open': 'Open',
      'feed.star': 'Save',
      'feed.unstar': 'Unsave',
      'feed.hide': 'Hide',
      'feed.openIdea': 'Recorded → open idea',
      'feed.record': 'Record as idea',
      'feed.prefill': 'Edit then save',
      'feed.starred': 'Saved',
      'feed.unstarred': 'Unsaved',
      'feed.hidden': 'Hidden — it will not show on the boards again (restore under Settings → Feed).',
      'feed.recorded': 'Saved as an idea',
      'feed.alreadyRecorded': 'Already recorded',
      'feed.prefilled': 'Saved to inbox: {id}',
      'feed.refreshFailed': 'Refresh failed: {msg}',
      'feed.hideTitle': 'Hide this item?',
      'feed.hideBody': 'It disappears from every board, the creator feed and favorites (the favorite record itself is kept). Hiding is permanent; restore under Settings → Feed.',
      'feed.hideConfirm': 'Hide',
      'feed.cancel': 'Cancel',
      'feed.prefillTitle': 'Record this idea (editable)',
      'feed.prefillTags': 'Tags (space separated)',
      'feed.prefillSave': 'Save idea',
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
      'board.moveTo': 'Move to:',
      'board.tasks': 'Tasks（Continue = keep working in the same worktree; Retry = new task with the same instruction）',
      'board.taskFollow': 'Continue',
      'board.taskRetry': 'Retry',
      'board.taskFollowHint': 'Continue: append an instruction to this task (same worktree, same session)',
      'board.taskRetryHint': 'Retry: start a NEW task with the same instruction (new worktree from base; the old one is kept)',
      'board.taskSend': 'Send',
      'board.taskCancel': 'Cancel',
      'board.taskQueued': 'Queued — it will keep going. Watch progress in the full panel (or ask "how is the task doing").',
      'board.taskQueuedRetry': 'Started a new task with the same instruction.',
      'board.taskBlocked': 'This task is still running ({st}) — wait or interrupt it first',
      'board.taskActive': 'running',
      'board.taskInterrupted': 'Interrupted: {msg}',
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
      'board.accept': 'Accept & merge',
      'board.acceptOnly': 'Record only',
      'board.acceptAgain': 'Re-check (already merged)',
      'board.acceptAck': 'Merge despite failed verify',
      'board.accepting': 'Accepting…',
      'board.verifyOk': 'verify passed',
      'board.verifyFail': 'verify failed',
      'board.couldNotAccept': 'Not accepted: {msg}',
      'card.accept.merged': 'Merged',
      'card.accept.recorded': 'Recorded (not merged)',
      'card.accept.needsAck': 'Verify failed — needs a human to tick "merge anyway"',
    };

    /**
     * 语义色（状态徽章用）：**先取 DSH 宿主的设计令牌**，取不到才退回我们自己的色板。
     *
     * ⚠️ 2026-10-07 修：这里以前写的是 `--dsh-color-*` —— 那个前缀**宿主根本没有**（DSH 0.2.0-rc.2 用的是
     * `--dsw-*`，见 `dsh-client-ui-theme`），所以一直是「取不到 → 退回硬编码色」。用户看到「succeeded 是灰的」
     * 一半是因为这个；另一半见下面 `TASK_STATUS_COLOR`（任务状态压根没进配色表）。
     * 背景优先用宿主的 `…-tertiary` 淡底令牌（深浅主题各一套）；宿主没有 tertiary 的（error）才用
     * `color-mix(...)` 现兑（宿主自己也这么干，如 `--dsw-alias-label-shimmer`）。
     */
    const tone = (name) => {
      const table = {
        ok: ['var(--dsw-alias-state-success-tertiary, rgba(46,160,67,0.15))', 'var(--dsw-alias-state-success-primary, #1a7f37)'],
        warn: ['var(--dsw-alias-state-warn-tertiary, rgba(219,171,10,0.18))', 'var(--dsw-alias-state-warn-label, #bb8009)'],
        err: ['color-mix(in srgb, var(--dsw-alias-state-error-primary, #d1242f) 16%, transparent)', 'var(--dsw-alias-state-error-primary, #d1242f)'],
        info: ['var(--dsw-alias-state-business-tertiary, rgba(56,139,253,0.15))', 'var(--dsw-alias-state-business-primary, #388bfd)'],
        accent: ['rgba(163,113,247,0.18)', '#8957e5'],
        grey: ['var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.18))', 'var(--dsw-alias-label-tertiary, #6e7781)'],
      };
      return table[name] ?? table.grey;
    };

    /** 想法状态 → 语义色（与桌面端 `.pill.<status>` 同一套语义） */
    const STATUS_COLOR = {
      inbox: tone('info'),
      scoping: tone('warn'),
      ready: tone('ok'),
      developing: tone('accent'),
      review: tone('warn'),
      done: tone('ok'),
      archived: tone('grey'),
    };

    /**
     * **任务状态** → 语义色（与桌面端 `TaskPill` 的口径逐档对齐）：
     * 成功=绿 · 失败=红 · 跑=蓝 · 等你回复=琥珀 · 排队/取消=灰。
     * 用户 2026-10-07 问的那条（截图里 `succeeded` 是灰的）就是它——以前这张表**根本不存在**，
     * 任务状态落进了 `T.chip` 的默认灰，所以「成功」和「已取消」长得一样。
     */
    const TASK_STATUS_COLOR = {
      queued: tone('grey'),
      running: tone('info'),
      waiting_input: tone('warn'),
      succeeded: tone('ok'),
      failed: tone('err'),
      cancelled: tone('grey'),
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
      dot: (ok) => ({ width: 8, height: 8, borderRadius: 999, flex: 'none', background: ok ? 'var(--dsw-alias-state-success-primary, #2ea043)' : 'var(--dsw-alias-state-warn-primary, #d29922)' }),
      chip: (status) => {
        // 任务状态优先（两张表里没有重名），都没有才落到灰
        const [bg, fg] = TASK_STATUS_COLOR[status] ?? STATUS_COLOR[status] ?? tone('grey');
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

    /**
     * 想法状态徽章：颜色按语义分档（`STATUS_COLOR`），**文案用本地化列名**（`board.col.*`，
     * 与看板列头逐字一致：「review」显示成「待验收」）。找不到文案就退回原始状态名；
     * `title` / `data-idea-status` 永远留原始值，排查用。
     */
    const statusChip = (status, t) => {
      const st = String(status ?? '?');
      const key = `board.col.${st}`;
      const label = t ? t(key) : key;
      return jsx.jsx('span', { style: T.chip(st), title: st, 'data-idea-status': st, children: label === key ? st : label }, 'chip');
    };

    /**
     * 任务状态徽章：颜色见 `TASK_STATUS_COLOR`，文案用 `card.task.st.*`（与桌面端 `TASK_LABEL` 同口径：
     * succeeded → 已完成）。`title` / `data-task-status` 留原始状态名。
     */
    const taskStatusChip = (status, t) => {
      const st = String(status ?? '?');
      const key = `card.task.st.${st}`;
      const label = t ? t(key) : key;
      return jsx.jsx('span', { style: T.chip(st), title: st, 'data-task-status': st, children: label === key ? st : label }, 'chip');
    };

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
        : toolName === 'aitm_task_follow_up' ? `继续任务 ${String(args.taskId ?? '…')}`
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
        children: jsx.jsx('div', { style: { ...T.sub, color: 'var(--dsw-alias-state-error-primary, #d1242f)' }, children: String(reason).slice(0, 400) }, 'why'),
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
          statusChip(meta.status, t),
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
                statusChip(i.status, t),
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
            statusChip(meta.status, t),
            meta.priority ? jsx.jsx('span', { style: { opacity: 0.7 }, children: String(meta.priority) }, 'p') : null,
            (meta.tags ?? []).slice(0, 6).map((tag) => jsx.jsx('span', { style: T.chip(null), children: String(tag) }, String(tag))),
            meta.repo ? jsx.jsx('span', { style: { opacity: 0.7 }, children: String(meta.repo) }, 'repo') : null,
          ] }, 'sub'),
          jsx.jsx('div', { style: { ...T.sub, display: 'block', whiteSpace: 'pre-wrap', maxHeight: 96, overflow: 'auto' }, children: String(meta.description || t('card.ideaDetail.noBody')).slice(0, 400) }, 'body'),
          tasks.length
            ? jsx.jsxs('div', { style: { marginTop: 6 }, children: [
                jsx.jsx('div', { style: { ...T.sub, marginTop: 0 }, children: t('card.ideaDetail.tasks') }, 'h'),
                tasks.slice(0, 5).map((x) => jsx.jsxs('div', { style: T.row, children: [
                  taskStatusChip(x.status, t),
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
                taskStatusChip(x.status, t),
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
            taskStatusChip(task.status, t),
            task.turns ? jsx.jsx('span', { children: t('card.task.turns', { n: String(task.turns) }) }, 'turn') : null,
            task.adapterId ? jsx.jsx('span', { style: { opacity: 0.7 }, children: String(task.adapterId) }, 'adapter') : null,
          ] }, 'sub'),
          task.error ? jsx.jsx('div', { style: { ...T.sub, color: 'var(--dsw-alias-state-error-primary, #d1242f)' }, children: String(task.error).slice(0, 300) }, 'err') : null,
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
                  statusChip(i.status, t),
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
        case 'accept':
          return AcceptCard({ meta, t });
        default:
          return FallbackCard({ text, toolName, t });
      }
    }

    /**
     * 验收卡（aitm_task_accept）：合并了 / 只记验收 / 验证没过被拦下，三种都要一眼看清。
     * 具体原因（「主区脏」「冲突」「验证没过」）走 detail —— 内核原话，别改写成「失败了」。
     */
    function AcceptCard({ meta, t }) {
      const merged = meta.merged !== false;
      const vd = meta.verify && typeof meta.verify === 'object' ? meta.verify : null;
      return jsx.jsx(Card, {
        t,
        icon: 'IconCheckCircleOutlineRegular',
        title: String(meta.ideaTitle ?? meta.taskId ?? t('board.accept')),
        accent: true,
        children: jsx.jsxs('div', { children: [
          jsx.jsxs('div', { style: T.sub, children: [
            jsx.jsx('span', { style: T.chip(null), children: merged ? t('card.accept.merged') : t('card.accept.recorded') }, 'k'),
            meta.baseRef ? jsx.jsx('span', { style: { opacity: 0.75 }, children: `→ ${String(meta.baseRef)}` }, 'base') : null,
            vd ? jsx.jsx('span', { style: T.chip(vd.ok ? 'succeeded' : 'failed'), children: vd.ok ? t('board.verifyOk') : t('board.verifyFail') }, 'v') : null,
          ] }, 'sub'),
          vd && !vd.ok && vd.note ? jsx.jsx('div', { style: { ...T.sub, color: 'var(--dsw-alias-state-error-primary, #d1242f)' }, children: String(vd.note).slice(0, 200) }, 'vnote') : null,
          meta.detail ? jsx.jsx('div', { style: { ...T.sub, opacity: 0.85 }, children: String(meta.detail).slice(0, 240) }, 'detail') : null,
        ] }, 'body'),
      });
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
      'aitm_task_follow_up',
      'aitm_calendar_day',
      'aitm_repo_status',
      'aitm_backup_now',
      'aitm_task_accept',
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
      /**
       * 列宽：桌面**定宽 172**；窄容器（手机）82% —— 一列占满大半、右侧露下一列示意可横滑。
       *
       * 必须写成 `width`（定宽），**不能写成 `flexBasis`** —— 用户真机报过「卡片宽度太大」：
       * 没有 width 时，这一列的 `min-width: auto` 会取**内容最小值**（flex 规范的内容相关最小尺寸），
       * 而卡片里那行「（素材来源…）原文：https://…」是 `white-space: nowrap` 的单行省略号，
       * 它的内容最小值约 500px ⇒ 整列被撑到 500px，卡片跟着一起变宽。
       * `width` 是「指定尺寸」，内容最小值被它压住；`minWidth: 0` 再兜一层（防以后又混进长不可断串）。
       */
      col: (over) => ({
        flex: 'none',
        width: NARROW_PANEL ? '82%' : 172,
        minWidth: 0,
        maxWidth: '100%',
        background: over ? 'var(--dsh-color-fill, rgba(127,127,127,0.10))' : 'transparent',
        borderRadius: 8,
        padding: 4,
        minHeight: 40,
        border: `1px dashed ${over ? 'var(--dsh-color-border, rgba(127,127,127,0.6))' : 'transparent'}`,
      }),
      colHead: { display: 'flex', alignItems: 'center', gap: 5, padding: '2px 4px 6px' },
      card: (sel) => ({
        background: 'var(--dsh-color-fill, rgba(127,127,127,0.08))',
        ...(COARSE_POINTER ? { padding: '9px 9px' } : {}),
        border: `1px solid ${sel ? 'var(--dsw-alias-state-business-primary, rgba(80,140,255,0.9))' : 'var(--dsh-color-border, rgba(127,127,127,0.22))'}`,
        borderRadius: 8,
        padding: '6px 7px',
        marginBottom: 5,
        cursor: 'pointer',
        userSelect: 'none',
      }),
      cardTitle: { display: 'flex', alignItems: 'flex-start', gap: 4, lineHeight: 1.35, wordBreak: 'break-word' },
      meta: { display: 'flex', alignItems: 'center', gap: 5, marginTop: 5, opacity: 0.75, fontSize: 11, flexWrap: 'wrap' },
      star: { border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0, flex: 'none', opacity: 0.85, fontSize: 13, lineHeight: 1, ...TAP },
      /** 「改状态」那一排小按钮（详情里用；触屏上点得中） */
      chip: () => ({
        border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.35))',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 999,
        cursor: 'pointer',
        padding: '0 8px',
        fontSize: 11.5,
        ...TAP,
      }),
      link: { cursor: 'pointer', opacity: 0.75, flex: 'none', display: 'inline-flex', alignItems: 'center', ...TAP_WIDE },
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
      const { idea, repo, taskCount, running, verifyFailed, selected, onOpen, onStar, onDragStart, onDragEnd, t } = props;
      const pri = priText(idea.priority);
      const meta = [
        pri ? jsx.jsx('span', { children: pri }, 'pri') : null,
        ...(idea.tags ?? []).slice(0, 2).map((tag) => jsx.jsx('span', { children: `#${String(tag)}` }, String(tag))),
        jsx.jsx('span', { style: { flex: 1 } }, 'grow'),
        taskCount ? jsx.jsx('span', { style: { color: running ? 'var(--dsw-alias-state-business-primary, #4a8cff)' : undefined }, children: `⌘ ${String(taskCount)}` }, 'tasks') : null,
        verifyFailed ? jsx.jsx('span', { style: { color: 'var(--dsw-alias-state-error-primary, #d35)' }, title: t('board.verifyFail'), children: '✗ 验证' }, 'v') : null,
        repo ? jsx.jsx('span', { children: repo }, 'repo') : null,
        jsx.jsx('span', { children: relTime(idea.updatedAt) }, 'time'),
      ].filter(Boolean);
      return jsx.jsx('article', {
        style: BOARD.card(selected),
        // 触屏上不给 draggable：HTML5 拖拽**不响应触摸**（拖不起来），开着反而会吃掉长按/滚动
      draggable: !COARSE_POINTER,
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

    /**
     * 详情里的一行任务（纯展示）：状态 / id / 轮次 + 「继续」「重试」，被中断时把原因原样写出来。
     *
     * - **继续**（`task.followUp`）：在同一 worktree 上追加一条指令（半成品接着干）—— 宿主重启把任务
     *   标成 failed 之后，这就是「怎么接着干」的入口。
     * - **重试**（`task.retry`）：用同样的指令**新起一条任务**（新 worktree、从基线开始；旧现场保留）。
     * - 正在跑的任务（queued/running/waiting_input）不给这两个按钮（内核也会拒），只写「进行中」。
     */
    function BoardTaskRow({ x, t, editing, text, onToggleEditor, onText, onSend, onRetry }) {
      const active = ['queued', 'running', 'waiting_input'].includes(String(x.status));
      return jsx.jsxs('div', { style: { borderTop: '1px solid var(--dsh-color-border, rgba(127,127,127,0.18))', padding: '5px 2px' }, 'data-task-row': x.id, children: [
        jsx.jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }, children: [
          taskStatusChip(x.status, t),
          jsx.jsx('span', { style: { opacity: 0.65, fontFamily: 'ui-monospace, monospace' }, children: String(x.id) }, 'id'),
          x.turns ? jsx.jsx('span', { style: { opacity: 0.6 }, children: `${String(x.turns)} 轮` }, 'turn') : null,
          active
            ? jsx.jsx('span', { style: { opacity: 0.7, marginLeft: 'auto' }, children: t('board.taskActive') }, 'act')
            : jsx.jsxs('span', { style: { marginLeft: 'auto', display: 'flex', gap: 4 }, children: [
                jsx.jsx('button', {
                  type: 'button',
                  style: BOARD.chip(),
                  title: t('board.taskFollowHint'),
                  'data-task-follow': '1',
                  onClick: onToggleEditor,
                  children: t('board.taskFollow'),
                }, 'follow'),
                jsx.jsx('button', {
                  type: 'button',
                  style: BOARD.chip(),
                  title: t('board.taskRetryHint'),
                  'data-task-retry': '1',
                  onClick: onRetry,
                  children: t('board.taskRetry'),
                }, 'retry'),
              ] }, 'acts'),
        ] }, 'row'),
        x.error ? jsx.jsx('div', { style: { fontSize: 11, opacity: 0.75, marginTop: 2, wordBreak: 'break-word' }, children: t('board.taskInterrupted', { msg: String(x.error) }) }, 'err') : null,
        editing
          ? jsx.jsxs('div', { style: { marginTop: 4 }, children: [
              jsx.jsx('textarea', {
                style: { ...BOARD.input, minHeight: 44, resize: 'vertical', fontFamily: 'inherit' },
                placeholder: t('board.taskFollowHint'),
                value: text,
                'data-task-input': '1',
                onChange: (e) => onText(e.target.value),
              }, 'input'),
              jsx.jsxs('div', { style: { display: 'flex', gap: 4, marginTop: 4 }, children: [
                jsx.jsx('button', { type: 'button', style: BOARD.chip(), 'data-task-send': '1', onClick: onSend, children: t('board.taskSend') }, 'send'),
                jsx.jsx('a', { style: BOARD.link, onClick: onToggleEditor, children: t('board.taskCancel') }, 'cancel'),
              ] }, 'row2'),
            ] }, 'editor')
          : null,
      ] });
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
                      // 验证没过（且任务还没被验收/丢弃）→ 卡片上打一个 ✗ 验证
                      verifyFailed: tasks.some(
                        (x) => x.ideaId === idea.id && x.verify && x.verify.ok === false && x.status !== 'succeeded' && x.status !== 'cancelled',
                      ),
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
      const [accepting, setAccepting] = react.useState(false);
      const [acceptNote, setAcceptNote] = react.useState(null);
      const [ackFail, setAckFail] = react.useState(false); // 「验证没过也要合」
      // 任务「继续」（followUp）／「重试」（retry）：taskId + 内联指令
      const [taskAct, setTaskAct] = react.useState(null); // { taskId, text }
      const [taskNote, setTaskNote] = react.useState(null);
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

      /**
       * 验收（原生看板里的那两颗按钮）。
       *
       * 与完整面板同一口径：默认合并回基线；`task.accept` 回 `{ok:false, detail}` 说明被门拦下
       * （验证没过 / 主区脏 / 冲突）—— 原话显示，并在「验证没过」时亮出勾选框。
       * 「人在界面上点」本身就是人工审批，所以这里不再弹审批卡（对话里的 aitm_task_accept 才会弹）。
       */
      const acceptTask = async (merge) => {
        const taskId = detail?.meta?.tasks?.[0]?.id;
        if (!taskId || accepting) return;
        setAccepting(true);
        setAcceptNote(null);
        try {
          const r = await postAction(base, 'task.accept', {
            taskId,
            merge,
            ...(merge && ackFail ? { acknowledgeVerifyFailure: true } : {}),
          });
          const text = String(r?.detail ?? '');
          if (r?.ok === false) {
            setAcceptNote(t('board.couldNotAccept', { msg: text || '?' }));
            if (/验证没过/.test(text)) setAckFail(false); // 让人显式再勾一次
          } else {
            setAcceptNote(text);
            setAckFail(false);
            await openDetail(detail.id);
            await load();
          }
        } catch (err) {
          setAcceptNote(t('board.couldNotAccept', { msg: String(err?.message ?? err) }));
        } finally {
          setAccepting(false);
        }
      };

      /**
       * 「继续」（task.followUp）：在**同一个任务**上追加一条指令 —— 复用同一 worktree 与引擎会话，
       * 半成品接着干。任务被宿主中断（关 DSH）、失败、跑完没过验收，都用这条。
       * 与「重试」的区别：重试是 `task.retry`，用同样的指令**新起一条任务**（新 worktree、从基线开始）。
       */
      const followTask = async (taskId) => {
        const text = String(taskAct?.text ?? '').trim();
        if (!text) return;
        setTaskNote(null);
        try {
          await postAction(base, 'task.followUp', { taskId, instruction: text });
          setTaskAct(null);
          setTaskNote(t('board.taskQueued'));
          if (detail) await openDetail(detail.id);
          await load();
        } catch (err) {
          setTaskNote(String(err?.message ?? err));
        }
      };

      const retryTask = async (taskId) => {
        setTaskNote(null);
        try {
          await postAction(base, 'task.retry', { taskId });
          setTaskAct(null);
          setTaskNote(t('board.taskQueuedRetry'));
          if (detail) await openDetail(detail.id);
          await load();
        } catch (err) {
          setTaskNote(String(err?.message ?? err));
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
        const newest = detail.meta?.tasks?.[0] ?? null;
        const verify = newest?.verify ?? null;
        const merged = Boolean(newest?.mergedAt);
        const acceptBar = newest
          ? jsx.jsxs('div', { style: { ...BOARD.toolbar, alignItems: 'center' }, 'data-board-accept': '1', children: [
              jsx.jsx('button', {
                type: 'button',
                style: { ...BOARD.select, cursor: accepting ? 'progress' : 'pointer' },
                disabled: accepting,
                onClick: () => void acceptTask(true),
                children: accepting ? t('board.accepting') : merged ? t('board.acceptAgain') : t('board.accept'),
              }, 'accept'),
              jsx.jsx('a', { style: BOARD.link, onClick: () => void acceptTask(false), children: t('board.acceptOnly') }, 'only'),
              verify
                ? jsx.jsx('span', {
                    style: { color: verify.ok ? 'var(--dsw-alias-state-success-primary, #1a7f37)' : 'var(--dsw-alias-state-error-primary, #d35)', opacity: verify.ok ? 0.9 : 1 },
                    title: String(verify.note ?? ''),
                    children: verify.ok ? t('board.verifyOk') : t('board.verifyFail'),
                  }, 'v')
                : null,
              verify && !verify.ok
                ? jsx.jsxs('label', { style: { display: 'flex', alignItems: 'center', gap: 3, marginLeft: 'auto', fontSize: 11.5 }, children: [
                    jsx.jsx('input', { type: 'checkbox', checked: ackFail, onChange: (e) => setAckFail(e.target.checked) }, 'cb'),
                    t('board.acceptAck'),
                  ] }, 'ack')
                : null,
            ] }, 'acceptbar')
          : null;
        return jsx.jsxs('div', { style: BOARD.wrap, 'data-board': 'detail', children: [
          jsx.jsxs('div', { style: BOARD.toolbar, children: [
            jsx.jsx('a', { style: BOARD.link, onClick: () => setDetail(null), children: t('board.back') }, 'back'),
            jsx.jsx('span', { style: { flex: 1 } }, 'grow'),
            onOpenFull ? jsx.jsx('a', { style: BOARD.link, onClick: () => onOpenFull(detail.id), children: t('board.openFull') }, 'full') : null,
          ] }, 'bar'),
          acceptBar,
          /* 「改状态」：手机上 HTML5 拖拽**不响应触摸**（拖不起来），所以详情里必须有一条点得动的路。
             与拖拽走同一个 action（idea.setStatus），非法流转的报错也同一条口径。 */
          jsx.jsxs(
            'div',
            {
              style: { ...BOARD.toolbar, gap: 4, alignItems: 'center' },
              'data-board-move': '1',
              children: [
                jsx.jsx('span', { style: { opacity: 0.7, flex: 'none' }, children: t('board.moveTo') }, 'label'),
                ...IDEA_ORDER.filter((st) => st !== detail.meta?.status).map((st) =>
                  jsx.jsx(
                    'button',
                    {
                      type: 'button',
                      style: BOARD.chip(),
                      'data-move': st,
                      onClick: () => void changeStatus(detail.id, st),
                      children: t(`board.col.${st}`),
                    },
                    st,
                  ),
                ),
              ],
            },
            'move',
          ),
          acceptNote ? jsx.jsx('div', { style: { padding: '4px 10px', fontSize: 11.5, opacity: 0.9 }, 'data-board-accept-note': '1', children: acceptNote }, 'anote') : null,
          /* ── 任务区：被中断 / 失败 / 跑完的任务，「继续」或「重试」 ──
             （宿主重启会把 running 标成 failed 并写「应用重启导致中断；worktree 仍在，可直接继续对话」——
             这里就是那个「继续」的入口；内核 task.followUp 复用同一 worktree 与引擎会话）*/
          jsx.jsxs('div', { style: { padding: '0 8px 4px' }, 'data-board-tasks': '1', children: [
            jsx.jsx('div', { style: { fontSize: 11.5, opacity: 0.7, padding: '2px 2px 4px' }, children: t('board.tasks') }, 'h'),
            ...(detail.meta?.tasks ?? []).map((x) =>
              jsx.jsx(
                BoardTaskRow,
                {
                  x,
                  t,
                  editing: taskAct?.taskId === x.id,
                  text: taskAct?.text ?? '',
                  onToggleEditor: () => setTaskAct(taskAct?.taskId === x.id ? null : { taskId: x.id, text: '' }),
                  onText: (v) => setTaskAct((a) => (a ? { ...a, text: v } : { taskId: x.id, text: v })),
                  onSend: () => void followTask(x.id),
                  onRetry: () => void retryTask(x.id),
                },
                String(x.id),
              ),
            ),
          ] }, 'tasks'),
          taskNote ? jsx.jsx('div', { style: { padding: '2px 10px 6px', fontSize: 11.5, opacity: 0.9 }, 'data-board-task-note': '1', children: taskNote }, 'tnote') : null,
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
        note ? jsx.jsx('div', { style: { padding: '4px 10px', color: 'var(--dsw-alias-state-error-primary, #d35)', fontSize: 11.5 }, 'data-board-note': '1', children: note }, 'note') : null,
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
        tasks: (d?.tasks ?? []).slice(0, 8).map((x) => ({
          id: x.id,
          status: x.status,
          turns: x.turns ?? 0,
          ...(x.error ? { error: String(x.error) } : {}),
          ...(x.verify ? { verify: { ok: x.verify.ok === true, note: String(x.verify.note ?? '') } } : {}),
          ...(x.workspace?.mergedAt ? { mergedAt: x.workspace.mergedAt } : {}),
          ...(x.workspace?.baseRef ? { baseRef: x.workspace.baseRef } : {}),
        })),
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
      head: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderBottom: '1px solid var(--dsh-color-border, #d8dae0)', flex: 'none', flexWrap: 'wrap' },
      nav: { border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.35))', background: 'transparent', color: 'inherit', borderRadius: 6, cursor: 'pointer', padding: '1px 7px', fontSize: 12, ...TAP_WIDE },
      month: { fontWeight: 600 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, padding: '6px 8px 0', flex: 'none' },
      dow: { textAlign: 'center', opacity: 0.6, fontSize: 11, padding: '2px 0' },
      cell: (inMonth, isToday, selected) => ({
        position: 'relative',
        textAlign: 'center',
        padding: '4px 0 2px',
        ...(COARSE_POINTER ? { paddingTop: 6, paddingBottom: 5 } : {}),
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
                jsx.jsx('div', { style: CAL.dots, children: [dot(ni, 'var(--dsw-alias-state-business-primary, #388bfd)'), dot(nf, 'var(--dsw-alias-state-warn-label, #bb8009)')] }, 'dots'),
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
          data.error ? jsx.jsx('div', { style: { color: 'var(--dsw-alias-state-error-primary, #d1242f)', marginTop: 6 }, children: `读数据失败：${data.error}` }, 'err') : null,
          selIdeas.length
            ? jsx.jsxs('div', { children: [
                jsx.jsx('div', { style: CAL.sectionTitle, children: `想法 ${selIdeas.length}` }, 'h'),
                selIdeas.map((i) => jsx.jsxs('div', {
                  style: CAL.item,
                  onClick: () => onOpenIdea?.(i.id),
                  title: '在面板里打开',
                  children: [
                    statusChip(i.status, t),
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
    const DOT = (ok) => ({ width: 8, height: 8, borderRadius: 999, background: ok ? 'var(--dsw-alias-state-success-primary, #2ea043)' : 'var(--dsw-alias-state-warn-primary, #d29922)', flex: 'none' });
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
            ready && view === 'feed' && !embedIdea
              ? // 合集也是**原生 React**（M3 逐页搬家第三页：看板 → 日历 → 合集）——三块同屏、
                // 目录条计数跳转/收起、记想法/收藏/隐藏都直接打后端；要对话/差异才走 iframe。
                // 点已记录的 ✓ → 回看板把那条想法摊开（与日历点想法同一条路）。
                jsx.jsx(AitmFeed, { base: cfg.base, onOpenIdea: (id) => { setBoardIdea(id); setView('board'); } })
              : ready && view === 'board' && !embedIdea
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
                            cfg.repoProblem ? jsx.jsx('div', { style: { color: 'var(--dsw-alias-state-error-primary, #d1242f)' }, children: `自检：${cfg.repoProblem}` }, 'problem') : null,
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

    /* ─────────── 原生合集（不走 iframe） ─────────── */

    /**
     * 格式化口径**抄内核**（`src/shared/feed-format.ts` 的 FEED_KIND_LABEL / compactNumber /
     * metricText / trendText）：插件是独立包、不能 import 仓库源码，所以这里是副本 ——
     * 改内核那份时记得同步（`verify-dsh` 有断言：类别名逐字比 + 固定样例上比输出）。
     * 结论面一句话：**卡片上看到的事实，与桌面面板逐字一致**，同一张卡在两处不显示成两个样子。
     */
    const FEED_KIND_LABEL = { model: '模型', tool: '工具', skill: '技能', repo: '项目', video: '视频' };

    /** 数字按中文习惯缩写：12345 → 1.2 万；123456789 → 1.2 亿（GitHub 那边仍用千分位） */
    function compactNumber(n, opts) {
      if (!Number.isFinite(n)) return '—';
      if (opts && opts.wan) {
        if (n >= 100000000) return `${(n / 100000000).toFixed(1)} 亿`;
        if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
        return String(n);
      }
      return n.toLocaleString('en-US');
    }

    /** 指标行：只有真有的指标才出现（缺 = 不显示，不写 0） */
    function metricText(item) {
      const m = item.metrics ?? {};
      const parts = [];
      if (item.source === 'github') {
        if (m.stars != null) parts.push(`★ ${compactNumber(m.stars)}`);
        if (m.starsToday != null) parts.push(`+${compactNumber(m.starsToday)}/日`);
        if (m.starsWeek != null) parts.push(`+${compactNumber(m.starsWeek)}/周`);
        if (m.starsMonth != null) parts.push(`+${compactNumber(m.starsMonth)}/月`);
        if (m.forks != null) parts.push(`⑂ ${compactNumber(m.forks)}`);
      } else {
        if (m.views != null) parts.push(`播放 ${compactNumber(m.views, { wan: true })}`);
        if (m.likes != null) parts.push(`赞 ${compactNumber(m.likes, { wan: true })}`);
        if (m.danmaku != null) parts.push(`弹幕 ${compactNumber(m.danmaku, { wan: true })}`);
      }
      return parts.join(' · ');
    }

    /** 趋势一行（7/30 日榜用）：只在有数据时出现 */
    function trendText(item) {
      const t = item.trend;
      if (!t || !t.ready) return null;
      const bits = [`上榜 ${Math.round(t.appearRatio * 100)}%`];
      if (t.avgRank != null) bits.push(`均名 #${t.avgRank}`);
      if (t.starVelocity != null) bits.push(`+${compactNumber(Math.round(t.starVelocity))}/日`);
      return bits.join(' · ');
    }

    /**
     * 「改一改再记」的草稿：与桌面卡片上那颗铅笔按钮**同一份预填**（标题 + 来源行 + 数据 + 简介）。
     * 不做「以此内容记录」的完整正文（那条走 `feed.record`，由内核生成）。
     */
    function feedPrefill(item) {
      const metrics = metricText(item);
      const description = [
        `来源：[${item.title}](${item.url})`,
        metrics ? `数据：${metrics}` : '',
        item.summary ? `\n${item.summary}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      return { title: String(item.title ?? ''), description, tags: ['资讯', item.source === 'github' ? 'GitHub' : 'B站'] };
    }

    /** 记录成功后就地标记（不重拉整份快照）——与桌面 store.recordFeedItem 的本地标记同一做法 */
    function markFeedRecorded(snapshot, key, ideaId) {
      const mark = (list) => (list ?? []).map((it) => (it.key === key ? { ...it, ideaId } : it));
      return {
        ...snapshot,
        github: { ...snapshot.github, today: mark(snapshot.github.today), week: mark(snapshot.github.week), month: mark(snapshot.github.month), newRepos: mark(snapshot.github.newRepos) },
        bilibili: {
          ...snapshot.bilibili,
          hot: mark(snapshot.bilibili.hot),
          ai: mark(snapshot.bilibili.ai),
          zones: (snapshot.bilibili.zones ?? []).map((z) => ({ ...z, items: mark(z.items) })),
          ups: (snapshot.bilibili.ups ?? []).map((u) => ({ ...u, items: mark(u.items) })),
        },
      };
    }

    /** 三个块的固定顺序与名字：目录条与块标题都由它派生（内核 FeedView 的 BLOCKS 同源） */
    const FEED_BLOCKS = [
      { id: 'github', label: 'GitHub 热榜', short: 'GitHub' },
      { id: 'bilibili', label: 'B站热榜', short: 'B站' },
      { id: 'favorites', label: '我的收藏', short: '收藏' },
    ];

    const FEED_COLLAPSE_KEY = 'aitm.feed.collapsed';

    function readFeedCollapsed() {
      const base = { github: false, bilibili: false, favorites: false };
      try {
        const raw = localStorage.getItem(FEED_COLLAPSE_KEY);
        if (!raw) return base;
        const parsed = JSON.parse(raw);
        return { github: Boolean(parsed.github), bilibili: Boolean(parsed.bilibili), favorites: Boolean(parsed.favorites) };
      } catch {
        return base;
      }
    }

    function saveFeedCollapsed(v) {
      try {
        localStorage.setItem(FEED_COLLAPSE_KEY, JSON.stringify(v));
      } catch {
        /* 隐私模式/存储被禁：收起状态记不住不影响使用 */
      }
    }

    const FEED = {
      wrap: { position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 12.5 },
      bar: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderBottom: '1px solid var(--dsh-color-border, #d8dae0)', flex: 'none', flexWrap: 'wrap' },
      nav: { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderBottom: '1px solid var(--dsh-color-border, #d8dae0)', flex: 'none', flexWrap: 'wrap' },
      navBtn: (active) => ({
        border: `1px solid ${active ? 'var(--dsw-alias-state-business-primary, rgba(80,140,255,0.9))' : 'var(--dsh-color-border, rgba(127,127,127,0.35))'}`,
        background: 'transparent',
        color: 'inherit',
        borderRadius: 999,
        padding: '1px 8px',
        fontSize: 11.5,
        cursor: 'pointer',
        ...TAP_WIDE,
      }),
      btn: { border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.35))', background: 'transparent', color: 'inherit', borderRadius: 6, cursor: 'pointer', padding: '2px 8px', fontSize: 12 },
      body: { flex: 1, minHeight: 0, overflow: 'auto', padding: '6px 8px 12px' },
      block: { border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.28))', borderRadius: 8, marginBottom: 8, overflow: 'hidden' },
      blockHead: { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', flexWrap: 'wrap' },
      chip: (tone) => ({
        fontSize: 11,
        padding: '0 6px',
        borderRadius: 999,
        border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.28))',
        opacity: 0.9,
        color: tone === 'bad' ? 'var(--dsw-alias-state-error-primary, #d35)' : tone === 'warn' ? 'var(--dsw-alias-state-warn-label, #bb8009)' : tone === 'ok' ? 'var(--dsw-alias-state-success-primary, #2ea043)' : undefined,
      }),
      collapse: { border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12, opacity: 0.75, padding: '0 2px' },
      tabs: { display: 'flex', gap: 4, padding: '0 8px 6px', flexWrap: 'wrap' },
      tab: (active) => ({
        border: '1px solid transparent',
        background: active ? 'var(--dsh-color-fill, rgba(127,127,127,0.12))' : 'transparent',
        color: 'inherit',
        borderRadius: 6,
        cursor: 'pointer',
        padding: '1px 7px',
        fontSize: 11.5,
        opacity: active ? 1 : 0.75,
        ...TAP_WIDE,
      }),
      hint: { opacity: 0.65, padding: '0 8px 6px', fontSize: 11.5, lineHeight: 1.5 },
      // min(232px, 100%)：窄屏（手机）下卡片铺满整行，不会横向溢出
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(232px, 100%), 1fr))', gap: 6, padding: '0 8px 8px' },
      card: {
        border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.22))',
        borderRadius: 8,
        padding: '6px 7px',
        background: 'var(--dsh-color-fill, rgba(127,127,127,0.06))',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
      },
      cardTitle: { display: 'flex', alignItems: 'baseline', gap: 4, lineHeight: 1.35, wordBreak: 'break-word' },
      title: { color: 'inherit', flex: 1, textDecoration: 'none', cursor: 'pointer' },
      kind: { fontSize: 10.5, opacity: 0.75, flex: 'none' },
      meta: { display: 'flex', alignItems: 'center', gap: 5, marginTop: 4, opacity: 0.75, fontSize: 11, flexWrap: 'wrap' },
      summary: { opacity: 0.7, marginTop: 4, fontSize: 11.5, lineHeight: 1.45, maxHeight: 50, overflow: 'hidden' },
      actions: { display: 'flex', alignItems: 'center', gap: 4, marginTop: 'auto', paddingTop: 6 },
      /**
       * 图标按钮：**一律黑白**（用户口径，2026-10-07）——底色与字色都不上强调色，
       * 状态交给字形本身（★/☆、✓）与 title/aria-label。
       * 旧版：`primary` 是蓝底白字（记想法 / 已记录），已收藏是蓝星 —— 用户要求「不用颜色，改成黑白」。
       */
      iconBtn: () => ({
        ...TAP,
        border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.3))',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 6,
        cursor: 'pointer',
        padding: '0 5px',
        fontSize: 12,
        lineHeight: '18px',
        textDecoration: 'none',
        flex: 'none',
      }),
      fail: { display: 'flex', alignItems: 'center', gap: 5, margin: '0 8px 6px', padding: '4px 6px', borderRadius: 6, background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #d1242f) 12%, transparent)', color: 'var(--dsw-alias-state-error-primary, #d35)', fontSize: 11.5 },
      progress: { display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px 6px', opacity: 0.85, fontSize: 11.5, flex: 'none' },
      overlay: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20, padding: 8 },
      dialog: { background: 'var(--dsh-color-bg-elevated, #fff)', border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.35))', borderRadius: 8, padding: 10, width: 'min(100%, 400px)', boxShadow: '0 6px 24px rgba(0,0,0,0.25)' },
      input: { width: '100%', boxSizing: 'border-box', background: 'transparent', color: 'inherit', border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.35))', borderRadius: 6, padding: '3px 6px', fontSize: 12, outline: 'none', marginTop: 4, fontFamily: 'inherit' },
    };

    /**
     * 一张合集卡片（纯展示；动作回调都从外面给）—— 结构对齐桌面 `FeedView.tsx` 的 FeedCard。
     * 名字带 Item：工具卡那边已经有一个 `FeedCard`（对话里的合集卡），函数声明提升会互相顶掉（踩过一次）。
     * 名次 / 标题（外链）/ 类别 / 来源 / 副标题 / 指标 / 趋势 / 简介 / 收藏时间 / 底部动作条。
     * 动作按钮只留图标（R4），文案走 title/aria。
     */
    function FeedItemCard(props) {
      const { item, savedAt, onRecord, onOpenIdea, onStar, onHide, onPrefill, t } = props;
      const metrics = metricText(item);
      const trend = trendText(item);
      /** 图标按钮 —— 注意 jsx 的签名是 (type, props, key)：字形必须走 props.children（踩过一次：传成第三个参数 → 按钮是空的） */
      /** 动作按钮（只有图标，文案在 title/aria）：样式一律黑白，见 FEED.iconBtn 的注释 */
      const btn = (key, glyph, title, onClick) =>
        jsx.jsx('button', { type: 'button', style: FEED.iconBtn(), title, 'aria-label': title, children: glyph, onClick: (e) => { e.stopPropagation(); onClick(); } }, key);
      return jsx.jsxs('article', {
        style: FEED.card,
        'data-feed-card': item.key,
        children: [
          jsx.jsxs(
            'div',
            {
              style: FEED.cardTitle,
              children: [
                item.rank != null ? jsx.jsx('span', { style: { opacity: 0.6, flex: 'none' }, children: `#${String(item.rank)}` }, 'rank') : null,
                jsx.jsx('a', { style: FEED.title, href: item.url, target: '_blank', rel: 'noreferrer', title: String(item.title ?? ''), children: String(item.title ?? '(无标题)') }, 'title'),
                jsx.jsx('span', { style: FEED.kind, children: FEED_KIND_LABEL[item.kind] ?? String(item.kind ?? '') }, 'kind'),
              ].filter(Boolean),
            },
            'head',
          ),
          jsx.jsxs(
            'div',
            {
              style: FEED.meta,
              children: [
                jsx.jsx('span', { children: item.source === 'github' ? 'GitHub' : 'B站' }, 'src'),
                item.subtitle ? jsx.jsx('span', { children: String(item.subtitle) }, 'sub') : null,
                metrics ? jsx.jsx('span', { children: metrics }, 'metrics') : null,
                trend ? jsx.jsx('span', { children: trend }, 'trend') : null,
              ].filter(Boolean),
            },
            'meta',
          ),
          item.summary ? jsx.jsx('div', { style: FEED.summary, children: String(item.summary).slice(0, 180) }, 'sum') : null,
          savedAt ? jsx.jsx('div', { style: { ...FEED.meta, opacity: 0.6 }, children: t('feed.savedAt', { t: relTime(savedAt) }) }, 'saved') : null,
          jsx.jsxs(
            'div',
            {
              style: FEED.actions,
              children: [
                jsx.jsx('a', { style: FEED.iconBtn(), href: item.url, target: '_blank', rel: 'noreferrer', title: t('feed.open'), 'aria-label': t('feed.open'), children: '↗' }, 'open'),
                jsx.jsx('span', { style: { flex: 1 } }, 'grow'),
                // 收藏状态只用字形表达（实心 ★ = 已收藏），不上色
                btn('star', item.starred ? '★' : '☆', item.starred ? t('feed.unstar') : t('feed.star'), () => onStar?.(item.key, !item.starred)),
                btn('hide', '⊘', t('feed.hide'), () => onHide?.(item)),
                item.ideaId
                  ? btn('done', '✓', t('feed.openIdea'), () => onOpenIdea?.(item.ideaId))
                  : jsx.jsxs(
                      'span',
                      {
                        style: { display: 'flex', gap: 4 },
                        children: [
                          btn('prefill', '✎', t('feed.prefill'), () => onPrefill?.(item)),
                          btn('record', '✨', t('feed.record'), () => onRecord?.(item.key)),
                        ],
                      },
                      'new',
                    ),
              ].filter(Boolean),
            },
            'actions',
          ),
        ].filter(Boolean),
      });
    }

    /**
     * 原生合集（M3 逐页搬家第三页：看板 → 日历 → 合集）。
     *
     * 与桌面 `FeedView.tsx` 同一份口径：三块同屏（GitHub / B站 / 我的收藏）+ 目录条（计数、跳转、
     * 全部收起）+ 每块单独收起（`localStorage` 记着，重启后还在）+ 抓取进度与失败条。
     * 数据面走面板同款 `postAction`：`feed.get` 快照、`feed.refresh`（可只刷一源）、
     * `feed.record`（记进想法箱）、`feed.star`/`unstar`、`feed.hide`（隐藏前必须确认）。
     * 事件流订阅 `/api/events` 去抖 400ms —— 对话里记想法 / 别处收藏之后，这里自己跟一次。
     */
    function AitmFeed({ base, onOpenIdea }) {
      const [data, setData] = react.useState({ loading: true, snapshot: null, settings: null, error: null });
      const [note, setNote] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [collapsed, setCollapsed] = react.useState(readFeedCollapsed);
      const [active, setActive] = react.useState('github');
      const [favSource, setFavSource] = react.useState('all');
      const [tabOf, setTabOf] = react.useState({ github: 'today', bilibili: 'ai' });
      const [pendingHide, setPendingHide] = react.useState(null);
      const [draft, setDraft] = react.useState(null);
      const bodyRef = react.useRef(null);
      const loadRef = react.useRef(null);
      const t = (k, vars) => String(zh[k] ?? en[k] ?? k).replace(/\{(\w+)\}/g, (m, n) => (vars && n in vars ? String(vars[n]) : m));

      const load = react.useCallback(async () => {
        if (!base) return;
        try {
          const [snapshot, settings] = await Promise.all([
            postAction(base, 'feed.get', { refresh: false }),
            // 设置只用来显示「类别 / 关注 UP」这一行徽标；取不到不影响看榜单
            postAction(base, 'settings.get', {}).catch(() => null),
          ]);
          setData({ loading: false, snapshot, settings, error: null });
        } catch (err) {
          setData((d) => ({ ...d, loading: false, error: String(err?.message ?? err) }));
        }
      }, [base]);

      react.useEffect(() => {
        void load();
      }, [load]);

      loadRef.current = load;

      // 事件流：抓取进度（feed start/done）+ 记想法/收藏/隐藏都会广播 → 400ms 去抖后跟一次
      react.useEffect(() => {
        if (!base || typeof EventSource !== 'function') return undefined;
        let timer = null;
        let es = null;
        try {
          es = new EventSource(`${base}/api/events`);
          es.onmessage = (ev) => {
            try {
              const e = JSON.parse(ev.data);
              if (e && e.type === 'feed') setBusy(e.phase === 'start');
            } catch {
              /* 解析不了就当普通事件 */
            }
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

      const snap = data.snapshot;
      const gh = snap?.sources?.github;
      const bili = snap?.sources?.bilibili;
      const refreshing = busy || Boolean(gh?.refreshing) || Boolean(bili?.refreshing) || Boolean(snap?.refreshing);
      const enabled = data.settings?.feed?.enabled ?? true;
      const favorites = snap?.favorites ?? [];

      const refresh = async (source) => {
        if (!base) return;
        setBusy(true);
        setNote(null);
        try {
          const snapshot = await postAction(base, 'feed.refresh', source ? { source } : {});
          setData((d) => ({ ...d, snapshot, error: null }));
        } catch (err) {
          setNote(t('feed.refreshFailed', { msg: String(err?.message ?? err) }));
        } finally {
          setBusy(false);
        }
      };

      const applySnapshot = (snapshot, okText) => {
        setData((d) => ({ ...d, snapshot }));
        setNote(okText);
      };

      const star = async (key, starring) => {
        try {
          applySnapshot(await postAction(base, starring ? 'feed.star' : 'feed.unstar', { key }), starring ? t('feed.starred') : t('feed.unstarred'));
        } catch (err) {
          setNote(String(err?.message ?? err));
        }
      };

      const hide = async (key) => {
        try {
          applySnapshot(await postAction(base, 'feed.hide', { key }), t('feed.hidden'));
        } catch (err) {
          setNote(String(err?.message ?? err));
        }
      };

      const record = async (key) => {
        try {
          const r = await postAction(base, 'feed.record', { key });
          setData((d) => (d.snapshot ? { ...d, snapshot: markFeedRecorded(d.snapshot, key, r.ideaId) } : d));
          setNote(r.created ? t('feed.recorded') : t('feed.alreadyRecorded'));
        } catch (err) {
          setNote(String(err?.message ?? err));
        }
      };

      const createIdea = async () => {
        if (!draft || !String(draft.title ?? '').trim()) return;
        try {
          const idea = await postAction(base, 'idea.create', {
            title: String(draft.title).trim(),
            ...(draft.description ? { description: draft.description } : {}),
            ...(draft.tags && draft.tags.length ? { tags: draft.tags } : {}),
          });
          setDraft(null);
          setNote(t('feed.prefilled', { id: String(idea?.id ?? '') }));
        } catch (err) {
          setNote(String(err?.message ?? err));
        }
      };

      const toggleBlock = (id, next) =>
        setCollapsed((prev) => {
          const v = { ...prev, [id]: next == null ? !prev[id] : next };
          saveFeedCollapsed(v);
          return v;
        });

      const jumpTo = (id) => {
        setActive(id);
        if (collapsed[id]) toggleBlock(id, false);
        try {
          const el = bodyRef.current?.querySelector(`[data-feed-block="${id}"]`);
          if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch {
          /* 滚动失败不影响用 */
        }
      };

      const ghTabs = [
        { id: 'today', label: t('feed.tab.today'), hint: t('feed.hint.today'), items: snap?.github?.today ?? [] },
        { id: 'week', label: t('feed.tab.week'), hint: gh && gh.trendDays >= 3 ? t('feed.hint.trend') : t('feed.hint.week'), items: snap?.github?.week ?? [] },
        { id: 'month', label: t('feed.tab.month'), hint: t('feed.hint.month'), items: snap?.github?.month ?? [] },
        { id: 'new', label: t('feed.tab.new'), hint: t('feed.hint.new'), items: snap?.github?.newRepos ?? [] },
      ];
      const upAll = (snap?.bilibili?.ups ?? []).flatMap((u) => u.items ?? []);
      const biliTabs = [
        ...((snap?.bilibili?.ups ?? []).length
          ? [{ id: 'ups', label: t('feed.tab.ups'), hint: t('feed.hint.ups'), items: [...upAll].sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0)).slice(0, 80) }]
          : []),
        { id: 'ai', label: t('feed.tab.ai'), hint: t('feed.hint.ai'), items: snap?.bilibili?.ai ?? [] },
        { id: 'hot', label: t('feed.tab.hot'), hint: t('feed.hint.hot'), items: snap?.bilibili?.hot ?? [] },
        ...(snap?.bilibili?.zones ?? []).map((z) => ({ id: `zone-${String(z.tid)}`, label: `${z.name} 排行榜`, hint: t('feed.hint.zone'), items: z.items ?? [] })),
      ];

      /** 当前页签：设置变了（新订阅分区 / 取消订阅）原来的页签可能没了 —— 回落到第一个 */
      const activeTabOf = (tabs, key) => (tabs.some((x) => x.id === tabOf[key]) ? tabOf[key] : (tabs[0]?.id ?? ''));
      const tabItems = (tabs, key) => tabs.find((x) => x.id === activeTabOf(tabs, key))?.items ?? [];
      const setTab = (key, id) => setTabOf((prev) => ({ ...prev, [key]: id }));

      const counts = {
        github: (snap?.github?.today?.length ?? 0) + (snap?.github?.week?.length ?? 0) + (snap?.github?.month?.length ?? 0) + (snap?.github?.newRepos?.length ?? 0),
        bilibili: (snap?.bilibili?.hot?.length ?? 0) + (snap?.bilibili?.ai?.length ?? 0) + (snap?.bilibili?.zones ?? []).reduce((a, z) => a + (z.items ?? []).length, 0) + upAll.length,
        favorites: favorites.length,
      };
      const total = counts.github + counts.bilibili;
      const allCollapsed = collapsed.github && collapsed.bilibili && collapsed.favorites;
      const zoneNames = (snap?.bilibili?.zones ?? []).map((z) => z.name).join('、');
      const pickedZones = (data.settings?.feed?.biliZones ?? []).length;
      const upMids = (data.settings?.feed?.upMids ?? []).length;
      const upErrors = (snap?.bilibili?.ups ?? []).filter((u) => u.error);
      const favCards = favorites.filter((f) => favSource === 'all' || f.item?.source === favSource).map((f) => ({ item: f.item, savedAt: f.savedAt }));
      const showBlocks = enabled && !(data.error && !snap);
      const cardProps = { onRecord: record, onStar: star, onHide: (item) => setPendingHide(item), onPrefill: (item) => setDraft(feedPrefill(item)), onOpenIdea, t };

      const sourceChip = (state) =>
        state
          ? jsx.jsx(
              'span',
              {
                style: FEED.chip(state.refreshing ? 'warn' : state.ok ? 'ok' : state.error ? 'bad' : null),
                title: state.error ?? undefined,
                children: state.refreshing ? t('feed.state.busy') : state.ok ? t('feed.state.ok') : state.error ? t('feed.state.bad') : t('feed.state.never'),
              },
              'chip',
            )
          : null;

      /**
       * 一块（GitHub / B站 / 收藏共用）：块头（标题 + 状态点 + 徽标 + 收起）+ 失败条 +
       * 页签 + 提示行 + 卡片网格。收起后只剩块头 —— 但**失败条照显示**（出问题不该被折叠藏起来）。
       */
      const renderBlock = (id, title, state, badges, extra, footer, onRetry) => {
        const isCollapsed = collapsed[id];
        const failed = state && !state.refreshing && state.ok === false && state.error;
        const cards = extra.cards ?? [];
        const tabs = extra.tabs ?? null;
        return jsx.jsxs(
          'section',
          {
            style: FEED.block,
            'data-feed-block': id,
            children: [
              jsx.jsxs(
                'div',
                {
                  style: FEED.blockHead,
                  children: [
                    jsx.jsx('b', { children: title }, 'title'),
                    sourceChip(state),
                    ...(badges ?? []).filter(Boolean),
                    extra.headExtra ?? null,
                    jsx.jsx('span', { style: { flex: 1 } }, 'grow'),
                    jsx.jsx(
                      'button',
                      {
                        type: 'button',
                        style: FEED.collapse,
                        title: isCollapsed ? t('feed.expand') : t('feed.collapse'),
                        'aria-expanded': !isCollapsed,
                        onClick: () => toggleBlock(id),
                        children: isCollapsed ? '▸' : '▾',
                      },
                      'collapse',
                    ),
                  ],
                },
                'head',
              ),
              failed
                ? jsx.jsxs(
                    'div',
                    {
                      style: FEED.fail,
                      role: 'alert',
                      children: [
                        jsx.jsx('span', { style: { flex: 1 }, children: `${t('feed.failed', { title })}：${String(state.error)}${state.fetchedAt ? t('feed.staleHint', { t: relTime(state.fetchedAt) }) : ''}` }, 'msg'),
                        jsx.jsx('button', { type: 'button', style: FEED.btn, onClick: onRetry, children: t('feed.retryOne', { name: id === 'github' ? ' GitHub' : ' B站' }) }, 'retry'),
                      ],
                    },
                    'fail',
                  )
                : null,
              isCollapsed
                ? null
                : jsx.jsxs(
                    'div',
                    {
                      children: [
                        tabs
                          ? jsx.jsx(
                              'div',
                              {
                                style: FEED.tabs,
                                role: 'tablist',
                                children: tabs.map((tb) =>
                                  jsx.jsxs(
                                    'button',
                                    {
                                      type: 'button',
                                      role: 'tab',
                                      'aria-selected': extra.activeTab === tb.id,
                                      style: FEED.tab(extra.activeTab === tb.id),
                                      onClick: () => extra.onTab?.(tb.id),
                                      children: [tb.label, jsx.jsx('span', { style: { opacity: 0.6, marginLeft: 4 }, children: String(tb.items.length) }, 'n')],
                                    },
                                    tb.id,
                                  ),
                                ),
                              },
                              'tabs',
                            )
                          : null,
                        extra.hintText ? jsx.jsx('div', { style: FEED.hint, children: extra.hintText }, 'hint') : null,
                        cards.length
                          ? jsx.jsx(
                              'div',
                              {
                                style: { ...FEED.grid, opacity: state?.refreshing ? 0.6 : 1 },
                                children: cards.map((c) => jsx.jsx(FeedItemCard, { item: c.item, savedAt: c.savedAt, ...cardProps }, String(c.item.key))),
                              },
                              'grid',
                            )
                          : jsx.jsx('div', { style: FEED.hint, children: extra.emptyText ?? t('feed.empty') }, 'empty'),
                        footer ? jsx.jsx('div', { style: FEED.hint, children: footer }, 'footer') : null,
                      ].filter(Boolean),
                    },
                    'body',
                  ),
            ].filter(Boolean),
          },
          id,
        );
      };

      return jsx.jsxs('div', {
        style: FEED.wrap,
        'data-feed': 'feed',
        children: [
          jsx.jsxs(
            'div',
            {
              style: FEED.bar,
              children: [
                jsx.jsx('b', { children: t('feed.title') }, 'title'),
                jsx.jsx(
                  'span',
                  {
                    style: { opacity: 0.7 },
                    children: snap?.updatedAt ? t('feed.updatedAt', { t: new Date(snap.updatedAt).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) }) : t('feed.never'),
                  },
                  'when',
                ),
                total ? jsx.jsx('span', { style: { opacity: 0.7 }, children: t('feed.total', { n: total }) }, 'total') : null,
                jsx.jsx('span', { style: { flex: 1 } }, 'grow'),
                jsx.jsx('button', { type: 'button', style: { ...FEED.btn, opacity: refreshing ? 0.6 : 1 }, disabled: refreshing, onClick: () => void refresh(), children: refreshing ? t('feed.refreshing') : t('feed.refresh') }, 'refresh'),
              ],
            },
            'bar',
          ),
          note ? jsx.jsx('div', { style: { ...FEED.hint, padding: '4px 10px 0' }, children: note }, 'note') : null,
          !data.loading && data.error && !snap
            ? jsx.jsxs(
                'div',
                {
                  style: { ...FEED.hint, color: 'var(--dsw-alias-state-error-primary, #d35)' },
                  children: [
                    t('feed.loadFailed', { msg: data.error }),
                    jsx.jsx('button', { type: 'button', style: { ...FEED.btn, marginLeft: 6 }, onClick: () => void load(), children: t('feed.retry') }, 'retry'),
                  ],
                },
                'err',
              )
            : null,
          showBlocks
            ? jsx.jsxs(
                'div',
                {
                  style: FEED.nav,
                  children: [
                    ...FEED_BLOCKS.map((b) =>
                      jsx.jsxs(
                        'button',
                        {
                          type: 'button',
                          style: FEED.navBtn(active === b.id && !collapsed[b.id]),
                          onClick: () => jumpTo(b.id),
                          'aria-label': t('feed.jump', { label: b.label, n: counts[b.id] }),
                          children: [b.short, jsx.jsx('span', { style: { opacity: 0.6, marginLeft: 4 }, children: String(counts[b.id]) }, 'n')],
                        },
                        b.id,
                      ),
                    ),
                    jsx.jsx('span', { style: { flex: 1 } }, 'grow'),
                    jsx.jsx(
                      'button',
                      {
                        type: 'button',
                        style: FEED.btn,
                        title: allCollapsed ? t('feed.expandAll') : t('feed.collapseAll'),
                        onClick: () => {
                          const v = { github: !allCollapsed, bilibili: !allCollapsed, favorites: !allCollapsed };
                          saveFeedCollapsed(v);
                          setCollapsed(v);
                        },
                        children: allCollapsed ? t('feed.expandAll') : t('feed.collapseAll'),
                      },
                      'collapseAll',
                    ),
                  ],
                },
                'nav',
              )
            : null,
          jsx.jsxs(
            'div',
            {
              style: FEED.body,
              ref: bodyRef,
              children: [
                refreshing
                  ? jsx.jsxs(
                      'div',
                      {
                        style: FEED.progress,
                        children: [
                          jsx.jsx('span', { children: t('feed.progress') }, 't'),
                          jsx.jsx('span', { style: { flex: 1 } }, 'grow'),
                          jsx.jsx('span', { style: { opacity: 0.7 }, children: t('feed.progressHint') }, 'h'),
                        ],
                      },
                      'progress',
                    )
                  : null,
                !enabled ? jsx.jsx('div', { style: { ...FEED.hint, padding: '8px 10px' }, children: t('feed.disabled') }, 'off') : null,
                showBlocks
                  ? jsx.jsxs(
                      'div',
                      {
                        children: [
                          renderBlock(
                            'github',
                            t('feed.block.github'),
                            gh,
                            [
                              gh && gh.trendDays < 3 ? jsx.jsx('span', { style: FEED.chip('warn'), children: t('feed.trendBuilding', { n: Math.max(1, gh.trendDays || 1) }) }, 'trend') : null,
                              gh?.hint ? jsx.jsx('span', { style: FEED.chip('warn'), children: String(gh.hint) }, 'hint') : null,
                            ],
                            {
                              tabs: ghTabs,
                              activeTab: activeTabOf(ghTabs, 'github'),
                              onTab: (id) => setTab('github', id),
                              hintText: ghTabs.find((x) => x.id === activeTabOf(ghTabs, 'github'))?.hint ?? '',
                              cards: tabItems(ghTabs, 'github').map((item) => ({ item })),
                              emptyText: t('feed.emptyGithub'),
                            },
                            null,
                            () => void refresh('github'),
                          ),
                          renderBlock(
                            'bilibili',
                            t('feed.block.bilibili'),
                            bili,
                            [
                              jsx.jsx('span', { style: FEED.chip(null), children: t('feed.zoneBadge', { zones: zoneNames || (pickedZones ? t('feed.zoneCount', { n: pickedZones }) : t('feed.zoneNone')), ups: upMids }) }, 'zones'),
                              upErrors.length
                                ? jsx.jsx('span', { style: FEED.chip('warn'), title: upErrors.map((u) => `${u.name || u.mid}：${u.error}`).join('\n'), children: t('feed.upFailed', { n: upErrors.length }) }, 'uperr')
                                : null,
                            ],
                            {
                              tabs: biliTabs,
                              activeTab: activeTabOf(biliTabs, 'bilibili'),
                              onTab: (id) => setTab('bilibili', id),
                              hintText: biliTabs.find((x) => x.id === activeTabOf(biliTabs, 'bilibili'))?.hint ?? '',
                              cards: tabItems(biliTabs, 'bilibili').map((item) => ({ item })),
                              emptyText: t('feed.emptyBili'),
                            },
                            jsx.jsxs('span', { children: [bili?.error ? t('feed.lastFailed', { msg: String(bili.error) }) : null, ' ', t('feed.biliFooter')] }, 'foot'),
                            () => void refresh('bilibili'),
                          ),
                          renderBlock(
                            'favorites',
                            t('feed.block.favorites'),
                            null,
                            [jsx.jsx('span', { style: FEED.chip('ok'), children: t('feed.favTotal', { n: favorites.length }) }, 'n')],
                            {
                              headExtra: jsx.jsx(
                                'span',
                                {
                                  style: { display: 'flex', gap: 4 },
                                  children: ['all', 'github', 'bilibili'].map((k) =>
                                    jsx.jsx(
                                      'button',
                                      {
                                        type: 'button',
                                        style: FEED.tab(favSource === k),
                                        onClick: () => setFavSource(k),
                                        children: `${k === 'all' ? t('feed.favAll') : k === 'github' ? 'GitHub' : 'B站'} ${String(k === 'all' ? favorites.length : favorites.filter((f) => f.item?.source === k).length)}`,
                                      },
                                      k,
                                    ),
                                  ),
                                },
                                'favFilters',
                              ),
                              cards: favCards,
                              hintText: t('feed.favHint', { hidden: (snap?.hidden ?? []).length }),
                              emptyText: favorites.length ? t('feed.favEmptySource') : t('feed.favEmpty'),
                            },
                            null,
                            null,
                          ),
                        ],
                      },
                      'blocks',
                    )
                  : null,
              ],
            },
            'body',
          ),
          pendingHide
            ? jsx.jsx(
                'div',
                {
                  style: FEED.overlay,
                  children: jsx.jsxs(
                    'div',
                    {
                      style: FEED.dialog,
                      children: [
                        jsx.jsx('b', { children: t('feed.hideTitle') }, 'title'),
                        jsx.jsx('div', { style: { marginTop: 4, opacity: 0.85, lineHeight: 1.5, wordBreak: 'break-word' }, children: `${pendingHide.source === 'github' ? 'GitHub' : 'B站'} · ${String(pendingHide.title ?? '')}` }, 'target'),
                        jsx.jsx('div', { style: { marginTop: 6, opacity: 0.75, lineHeight: 1.5 }, children: t('feed.hideBody') }, 'body'),
                        jsx.jsxs(
                          'div',
                          {
                            style: { display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 8 },
                            children: [
                              jsx.jsx('button', { type: 'button', style: FEED.btn, onClick: () => setPendingHide(null), children: t('feed.cancel') }, 'cancel'),
                              jsx.jsx(
                                'button',
                                {
                                  type: 'button',
                                  style: { ...FEED.btn, borderColor: 'var(--dsw-alias-state-error-primary, #d35)', color: 'var(--dsw-alias-state-error-primary, #d35)' },
                                  onClick: () => {
                                    const item = pendingHide;
                                    setPendingHide(null);
                                    void hide(item.key);
                                  },
                                  children: t('feed.hideConfirm'),
                                },
                                'ok',
                              ),
                            ],
                          },
                          'actions',
                        ),
                      ],
                    },
                    'box',
                  ),
                },
                'hide',
              )
            : null,
          draft
            ? jsx.jsx(
                'div',
                {
                  style: FEED.overlay,
                  children: jsx.jsxs(
                    'div',
                    {
                      style: FEED.dialog,
                      children: [
                        jsx.jsx('b', { children: t('feed.prefillTitle') }, 'title'),
                        jsx.jsx('input', { style: FEED.input, value: draft.title, onChange: (e) => setDraft({ ...draft, title: e.target.value }) }, 'title'),
                        jsx.jsx('textarea', { style: { ...FEED.input, minHeight: 90, resize: 'vertical' }, value: draft.description, onChange: (e) => setDraft({ ...draft, description: e.target.value }) }, 'desc'),
                        jsx.jsx(
                          'input',
                          {
                            style: FEED.input,
                            value: (draft.tags ?? []).join(' '),
                            placeholder: t('feed.prefillTags'),
                            onChange: (e) => setDraft({ ...draft, tags: e.target.value.split(/[\s,，]+/).filter(Boolean) }),
                          },
                          'tags',
                        ),
                        jsx.jsxs(
                          'div',
                          {
                            style: { display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 8 },
                            children: [
                              jsx.jsx('button', { type: 'button', style: FEED.btn, onClick: () => setDraft(null), children: t('feed.cancel') }, 'cancel'),
                              jsx.jsx(
                                'button',
                                {
                                  type: 'button',
                                  style: { ...FEED.btn, borderColor: 'var(--dsw-alias-state-business-primary, #4a8cff)', color: 'var(--dsw-alias-state-business-primary, #4a8cff)' },
                                  onClick: () => void createIdea(),
                                  children: t('feed.prefillSave'),
                                },
                                'save',
                              ),
                            ],
                          },
                          'actions',
                        ),
                      ],
                    },
                    'box2',
                  ),
                },
                'draft',
              )
            : null,
        ].filter(Boolean),
      });
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
      // 本页加载的 client.js（rev 只能快判：元数据哈希，跨机器/被 touch/被 HMR 换过都会「看起来不一致」）
      const hereUrl = loadedScriptUrlHere();
      const hereRev = hereUrl ? (/[?&]rev=([0-9a-zA-Z]{6,})/.exec(hereUrl)?.[1] ?? null) : null;
      const [pageSha, setPageSha] = react.useState(null);
      react.useEffect(() => {
        // rev 已经一致就不用多此一举；不一致时**取回自己这份代码的字节**算 sha1，和服务端给的文件 sha1 比 ——
        // 这是「本页到底是不是磁盘上那份」的定论（内容哈希，不掺时间戳）。
        if (!hereUrl || !cfg.clientSha || !cfg.clientRev || hereRev === cfg.clientRev) return undefined;
        let alive = true;
        void fetch(hereUrl, { credentials: 'same-origin' })
          .then((r) => (r.ok ? r.arrayBuffer() : null))
          .then((buf) => (buf ? sha1PrefixHex(buf, 12) : null))
          .then((sha) => {
            if (alive && sha) setPageSha(sha);
          })
          .catch(() => undefined);
        return () => {
          alive = false;
        };
      }, [hereUrl, hereRev, cfg.clientRev, cfg.clientSha]);
      const verdict = clientVerdict({ serverRev: cfg.clientRev, pageRev: hereRev, serverSha: cfg.clientSha, pageSha });
      const panelNote = () => {
        if (verdict === 'ok') return pageSha ? '（本页一致 · 内容已校验）' : '（本页一致）';
        if (verdict === 'stale') return `（⚠ 本页加载的是 ${hereRev ?? '另一份'}，重启 DSH + 硬刷）`;
        return '';
      };
      return jsx.jsxs('div', { className: 'aitm-settings-section', 'data-plugin': 'dsh-plugin-aitm', children: [
        jsx.jsx('h3', { children: TITLE }, 'h'),
        jsx.jsxs('div', { style: { marginTop: 6 }, children: [
          row('后端', cfg.base ?? '(自动拉起)'),
          row('健康', cfg.loading ? '检查中…' : cfg.health?.ok ? `正常 · ${cfg.health.actions} 个动作` : '不可用'),
          row('版本', cfg.identity?.version ? `${cfg.identity.version}（apiRev=${String(rev ?? '?')}，需要 ≥ ${String(revRequired)}）` : cfg.base ? '旧版（health 里没有身份字段）' : '—'),
          // 面板产物指纹：改了 client.js 却没生效时，这是最快的判据 ——
          // `client.js rev` 是**服务端文件**当前的值（= DSH 网络面板里 &rev= 的那个值），
          // 后面的「本页 …」是**这个页面实际加载的**那份；两者不一致 ⇒ 页面上是旧代码，重启 DSH + 硬刷。
          row('面板', (cfg.pluginVersion ? `${cfg.pluginVersion}${cfg.clientRev ? ` · client.js rev ${cfg.clientRev}` : ''}` : '—') + panelNote()),
          row('数据目录', cfg.identity?.dataDir ?? cfg.health?.dataDir ?? '—'),
          row('仓库', cfg.repo ?? '—'),
          row('错误', cfg.error ?? '无'),
        ] }, 'rows'),
        stale
          ? jsx.jsx('p', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #d1242f)', marginTop: 8 }, children: '后端版本不匹配：这个实例没有 feed.* 接口，面板与工具都会失败。按上面的处理步骤换到最新仓库起的实例。' }, 'stale')
          : null,
        jsx.jsx('p', { style: { fontSize: 12, opacity: 0.7, marginTop: 8 }, children: '环境变量：AITM_REPO（仓库路径）/ AITM_URL（连已有实例）/ AITM_SPAWN=0（只连不起）/ AITM_SUBPROCESS=0（不让宿主托管 CLI 进程）。改完重启 DSH 客户端。' }, 'hint'),
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
    exports.__components = { BoardTaskRow,  AitmPanel, AitmTabTitle, AitmSection, AitmToolCard, AitmCalendar, CalendarGrid, AitmBoard, BoardColumn, BoardCard, AitmFeed, FeedItemCard };
    /** 合集的口径副本（纯函数；verify-dsh 拿内核 src/shared/feed-format.ts 逐字比） */
    exports.__feedHelpers = { FEED_KIND_LABEL, FEED_BLOCKS, compactNumber, metricText, trendText, feedPrefill, markFeedRecorded };
    /** 给 verify 用：日历的纯计算（网格/分组），不依赖 React */
    exports.__calendarHelpers = { monthGridDays, shiftMonth, dayKeyLocal, groupByDayLocal, monthLabel, dayLabel, postAction };
    /** 给 verify 用：看板的列序 / 分桶 / 相对时间（纯计算，不依赖 React） */
    exports.__boardHelpers = { IDEA_ORDER, IDEA_LABEL, groupByStatus, relTime, loadedClientRev, loadedClientScriptUrl, clientVerdict };
    /** 给 verify 用：客户端半边依赖的服务名（每个都必须有提供者，否则整块 pending → 白屏） */
    exports.__clientInject = [...inject];
    /** 给 verify 用：卡片注册了哪些工具名 */
    exports.__cardTools = CARD_TOOLS;
    return module.exports;
  },
});
