# dsh-plugin-aitm · AI 任务台 × DeepSeek Harness 插件

把 AI 任务台接进 DSH 客户端的最小插件（**工具面 11 个：想法 → 规格 → 任务 → 备份**）。

```
┌─ DSH 客户端 ───────────────────────────────────────────┐
│  右侧栏：AI 任务台面板（看板/日历原生 React，合集 iframe）  │  ← 人看
│  对话：模型调用 aitm_idea_list / task_start / …（11 个） │  ← 模型用
│  设置：AI 任务台（后端地址 + 健康状态 + 后端来法）        │  ← 运维
└────────────────────────────────────────────────────────┘
                    │
                    ▼  本机回环（只绑 127.0.0.1）
     插件进程内的 L3 服务 —— 内核跑在 DSH 自己的进程里
     · 开发/自用：内核从**仓库**现编（`<repo>/dist-server/l3.mjs`）
     · 同事/分发：内核**自带在包里**（`dsh-plugin/dist-server/l3.mjs`，机器上不需要仓库）
     逃生通道：AITM_URL（连外部实例）/ AITM_L3=0（旧 spawn 桥）
```

**两种装法**：自己用 → 看下面「装（三步）」；装给别人（同事）→ 跳到「同事怎么装（分发版）」。

## 装（三步 · 自己开发/自用）

1. 装依赖（只为本地解析 `@deepseek-ai/dsh-tools`；DSH 宿主自带运行时）：

   ```bash
   cd dsh-plugin && npm install
   ```

2. 把插件挂进 DSH 的 profile（用 overlay，不动 profile 本身）：

   ```bash
   npx -y @deepseek-ai/dsh@0.2.0-rc.2 web --patch <repo>/dsh-plugin/aitm.patch.yml
   ```

   `aitm.patch.yml` 里的 `name:` 是**本机绝对路径**，换机器/Windows 要改（`verify-dsh.mjs` 会按当前机器自动生成一份）。

3. 环境变量（可选，不设就用默认）：

   | 变量 | 作用 | 默认 |
   |---|---|---|
   | `AITM_REPO` | AI 任务台仓库路径（要能跑 `node scripts/dev-web.mjs --prod`） | 插件目录的上一级 |
   | `AITM_URL` | 已有实例地址；设了就不自动起（连远程/已有进程） | 空 |
   | `AITM_SPAWN` | `0` = 只连不起（连不上就报错） | `1` |
   | `AITM_L3` | `0` = 退回 M1 的 spawn 桥（保命通道） | `1`（进程内 L3） |
   | `AITM_DEBUG` | `1` = 接住子进程日志（**会让 headless 不退出，只在手工调试时开**） | 空 |

## 同事怎么装（分发版 · 一条命令）

机器上**不需要** AI 任务台仓库：插件包里自带内核（`dist-server/l3.mjs`）与面板产物（`dist/`）。

1. **出包**（在你这边，仓库里跑；产物在 `release/`）：

   ```bash
   node scripts/vendor-plugin.mjs        # 构建 + 拷内核/面板产物进 dsh-plugin/ + npm pack
   # → release/dsh-plugin-aitm-0.2.0.tgz（脚本会核对包内容：缺内核/面板产物会直接报错）
   ```

2. **同事那台机器**：

   ```bash
   npm i -g pnpm                       # dsh plugin 走 pnpm（DSH Desktop 自带，CLI 要自己装）
   npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add <tarball 绝对路径>
   npx -y @deepseek-ai/dsh@0.2.0-rc.2 web --port 3081
   ```

   右侧栏就会出现「AI 任务台」，对话里 11 个工具可用。**数据目录**默认 `~/.ai-tasks-mgr`
   （想换就设 `AI_TASKS_HOME`；开发机那份在仓库 `.aitasks` 里，两边各自独立）。

3. **装机后自检**（有 DSH 问题先跑这个）：脚本头尾各有一行**汇总**（插件版本 · DSH 版本 ·
   后端来法 · apiRev · actions · 数据目录），把那两行连同第 ③ 节整段贴回来就够定位。

   ```bash
   cd <装到的目录或仓库>/dsh-plugin && node scripts/doctor.mjs
   ```

   `--profile web` 是**给 web app 用**的 profile；DSH Desktop 用的是保留名 `desktop`（同样一条 `add`，
   把 `--profile web` 换成 `--profile desktop`）。

> 为什么插件里能自带内核：`scripts/vendor-plugin.mjs` 把仓库构建出的 `dist-server/l3.mjs`（只这一个文件，
> `web.mjs`/`seed.mjs` 是 CLI 入口、插件用不上）与 `dist/` 拷进 `dsh-plugin/`（两边都在 `.gitignore` 里，
> 不进 git），`npm pack` 按 `files` 白名单打包。装了却没内核会**打包时就报错**，不会拖到同事装机才炸。

## 十一个工具（模型可调用）

| 工具 | 读写 | 干的事 |
|---|---|---|
| `aitm_health` | 只读 | 后端健康：action 数 / 数据目录 / 后端地址（面板打不开先调它） |
| `aitm_idea_list` | 只读 | 列想法（status / q / limit，默认 20 条）+ 各状态计数 |
| `aitm_idea_get` | 只读 | 取一条想法的详情：描述 / 标签 / 规格 / 关联任务 + 仓库 |
| `aitm_feed_today` | 只读 | 今日热榜条数与收藏数（读快照，不触发抓取） |
| `aitm_calendar_day` | 只读 | 某一天（默认今天，本机时区）：当天想法与收藏 + 当月计数 |
| `aitm_task_status` | 只读 | 任务进度：给 `taskId` 取一条，不给就列最近的任务 |
| `aitm_repo_status` | 只读 | 仓库与 worktree 占用（跑一次 `workspace.gc` 的**预演**，不动磁盘） |
| `aitm_idea_create` | **写** | 在灵感箱新建一条想法（标题必填；描述 / 标签 / 优先级可选） |
| `aitm_idea_set_status` | **写** | 改想法的状态（核心校验合法流转，非法流转会带着原因返回） |
| `aitm_task_start` | **写** | 开工：想法 + 一句指令 → 起一个 AI 任务（建 worktree、跑 CLI） |
| `aitm_backup_now` | **写** | 立即备份（`lean` 全量配置 / `full` 连 worktree 一起） |

只读工具**不问**；**写工具 4 个**（`idea_create` / `idea_set_status` / `task_start` /
`backup_now`）一律走审批闸 —— 它们会动仓库、worktree 和磁盘。

**写操作走审批闸**（`tools/pre-execute`，M2 第一步）：

- 默认**每次写都弹审批卡**，用户在 DSH 界面点「同意」才真正落地 —— 闸门在
  `apply()` 里注册（`ctx.on('tools/pre-execute', …)`），返回 `{kind:'ask', displayReason:{en,zh}}`；
- 顺序上**先问下游**（沙箱 / 权限档 / 别的插件）：下游拒了就以它为准，不会绕开它们；
- 缺参（比如没标题）直接 `deny`，不浪费用户的点击；已取消的调用 `cancel`；
- **没有审批通道时 fail-closed**：headless 里模型会收到
  `Error: tool "aitm_idea_create" requires approval, but no approval channel is available`，
  一条也不会写进去（verify ⑧ 就测这个）；
- 自用/自动化想跳过弹卡：`AITM_APPROVE=allow`（**风险自负**，文档里也说清了）；verify ⑨ 用它
  证明「放行后确实写得进去」。

## 对话里的工具卡（`tool.call.toolview`，M2 第二步）

十一个工具在对话流里**不是一行灰字**，而是各自一张卡（想法卡 / 详情卡 / 列表卡 / 合集卡 /
健康卡 / 任务卡 / 任务列表卡 / 日历卡 / 仓库卡 / 备份卡）：

- 数据怎么来：**工具侧**声明 `output.presentationMeta(args, value)` —— DSH 只对顶层调用计算一次，
  把返回值**逐字**放进会话记录的 `tool/result.meta`；**客户端侧**注册 keyed 槽
  `ctx.slots.register({ name: 'tool.call.toolview', key: '<工具名>', locale: 'aitm' }, Row)`
  读 `block.meta` 渲染。**别在客户端解析结果文本**（那是我第一版的想法，被文档否掉了）。
- 状态三态都管：跑之前说清「这次要干什么」（`start` 的 `argsRaw`）、成功给结构化摘要、
  失败把原因原样贴出来；**没有 meta 的旧会话**退回「卡片 + 原始文本」，不留白也不炸。
- 卡片右上角「在面板里看」= 切到我们自己的右侧栏页签（`ctx.sidebarRight.openTab('aitm')`）。
- 文案走 `ctx.locale.register('aitm', { zh, en })` + `t('card.…', { n })`（`{n}` 由 locale 服务插值）。
- 卡片是纯 react-dom 组件（`window.__ModuleLoader__.load` 里 require react/jsx-runtime），
  官方原子件（图标 / TextShimmer / Pill）取自 `@deepseek-ai/dsh-client-ui-primitives`，**取不到就降级成纯文本样式**。
- 十一个 key ＝ 十一个工具名；拼错永不渲染（keyed 槽只认精确 key），没认领的调用走 DSH 的通用行。
- **原生日历**（M2 第四步）：右侧栏的「日历」不再套 iframe，而是 React 月历（`CalendarGrid` 纯展示 +
  `AitmCalendar` 取数）：42 格、周一起排、想法蓝点 / 收藏黄点、翻月 / 今天 / 刷新、当天明细。
  数据走插件自己的 `/api`（`idea.list` + `feed.get`），并订阅 `/api/events` 去抖刷新；
  点一条想法 → 回**原生看板**并原地摊开那条详情。
- **原生看板**（M3 逐页搬家第一页）：右侧栏的「看板」也不再套 iframe（`BoardCard` / `BoardColumn` +
  `AitmBoard` 取数）。列序与列名是 `src/shared/labels.ts`（`IDEA_ORDER` / `IDEA_LABEL`）的副本，
  与内核**逐字一致**（`verify-dsh` 会直接读那个文件比对）；筛选走**服务端查**（`idea.list` 带 q/status）、
  计数一律取 `overview.get` 全量（R7）；拖拽改状态走 `idea.setStatus`，非法流转把内核原话显示出来。
  点卡片在原地摊开详情（复用工具卡那张 `IdeaDetailCard`），要看对话/差异再点「在完整面板里打开」。

## 验证

```bash
node scripts/verify-dist.mjs    # 12 项：**分发路径**（打 tarball → 解包 → 手工搭一个「pnpm 装完」的 profile
                                #        → 在没有仓库的目录起 dsh web：mode=vendor / apiRev=2 / 63 个 action /
                                #        面板静态产物可取 → 假模型跑工具 → 真命令 dsh plugin add 之后再跑一轮）
node scripts/verify-dsh.mjs     # 79 项：离线渲染 + 挂点护栏（不占 rightbar）+ 工具卡与日历 19 项
                                #        （11 种卡片 + 注册 / 文案 + 失败 / 运行 / 兜底 / 异常块 + 两条日历网格）
                                #        + 旧后端护栏 + 起前自检
                                #        + 审批闸（写→ask / 只读→放行 / 缺参→deny / 下游优先 / 取消）
                                #        + 激活 + boot 图 + 分片送达 + inject 服务都有提供者（防 R9 式 pending 白屏） + 端到端真数据
                                #        + meta 落盘（health / 写想法） + 写操作 fail-closed + 放行后落盘
                                #        + 后端来法（默认进程内 L3 / AITM_URL / AITM_L3=0）+ 不留常驻后端进程
                                #        + 工具层（真 L3 + 临时数据目录：11 个工具的输出过宿主同款 schema，含负例）
                                #        + 原生日历的取数通道（postAction 打真 L3 / 报错抛出 / 跨源 OPTIONS 预检带 CORS 头）
                                #        + 原生看板：列序/分桶/列渲染/空列/离线 7 列骨架、**与内核 labels.ts 逐字比对**、
                                #          两份词典键一致（zh 57 / en 57）、数据面走 postAction（服务端筛选 / 全量计数 /
                                #          星标写回 / 非法流转带原因）
node scripts/doctor.mjs         # 体检（不用起 DSH）：在哪个目录起后端、缺什么、后端日志尾巴
```

## 实现要点（踩过的坑，别踩第二遍）

1. **插件的长驻子进程会把 DSH「钉」住**：`dsh headless` 跑完一轮也不退出（实测卡到超时）。
   解法：spawn 时 `stdio: 'ignore'` + `child.unref()`，并在 `process.once('exit')` 里收掉它。
   （调试要日志就 `AITM_DEBUG=1`，那会重新接管道、headless 就不会自己退了 —— 只在手工调试时开。）
2. **`/api/health` 是路由，不是 action**：它不走 `POST /api/<action>` 那套信封，要 `GET` 直取。
3. **patch 只能定位已有 id**：新增插件用**不带 id** 的 `insert:`（带 id 的 insert 是往那个 group 里追加）。
4. **工具输出 schema 的 `required` 写在属性上**（对象级 `required` 会在激活期抛 `JsonSchemaError`）。
5. **`meta` 只能从会话日志里验**：`dsh --json`（headless）只吐 `type/callId/status/result`
   五个字段、**不带 meta**，所以「presentationMeta 有没有真的落盘」要读
   `$DSH_HOME/sessions/**/session.v4.jsonl.zstd`；而它是**多帧 zstd**（每次 append 一帧），
   一次 `zstdDecompressSync(整文件)` 只解出第一帧（我拿到过 189 字节的"空日志"），
   必须按魔数 `28 B5 2F FD` 切帧逐帧解。
6. **组件里的 `t` 要显式往下传**：工具卡是「外壳 + 若干子卡」的结构，子卡第一次写的时候
   直接用了模块级 `t` → `t is not defined`（verify 第一轮就拦住了）。React 并发渲染下
   也不该靠模块级变量传文案，一律 props 下发。
7. **launcher 参数必须排在 app 参数前**：`--profile/--patch` 在 `--json` 之前。
8. **客户端半边看不见 Node**：后端地址走宿主半边注册的 `/aitm-plugin/config`（同源 fetch）。
9. **别碰 `rightbar` —— 那是「座位」单占位槽**（R9 白屏事故根因）。DSH 自己的
   `@deepseek-ai/dsh-client-ui-sidebar-right` 要注册 `rightbar`；谁先注册，第二个就在 apply 里抛
   `single slot "rightbar" already has a registration at priority 0` → 对方 failed → 依赖它的
   `sessions/uiSession` 全 pending → `web boot: N entries did not activate` + 白屏。
   **正确挂法＝注册自己的右侧栏页签类型**（下一条）。
10. **右侧栏页签扩展点（三条一起才生效）**：
   ```js
   ctx.sidebarRightTabs.register({ id: 'dsh-plugin-aitm', kind: 'aitm', priority: 'extension',
     multiple: false, title: () => 'AI 任务台',
     guide: [{ id: 'open', order: 40, title: () => 'AI 任务台', description: () => '…' }] });
   ctx.slots.inject('sidebar.right.pane.tab',       () => ctx.slots.register({ name: 'sidebar.right.pane.tab',       key: 'dsh-plugin-aitm' }, Body));
   ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: 'dsh-plugin-aitm' }, Title));
   ```
   两个 keyed 槽的 `key` ＝ 类型的 **`id`**（不是 `kind`）；开面板用 `ctx.sidebarRight.openTab('<kind>')`
   （`openTab` 属于「当前会话」，没有会话时不要调；用户也能从右侧栏的引导页点进来）。

11. **后端默认进程内（L3），不是子进程**（M2 第三步）：M1 的桥 spawn 一个
    `scripts/dev-web.mjs --prod` 子进程、靠 `%TEMP%/aitm-dsh-backend.json` 登记表复用它 —— 这条
    路踩过「复用了旧实例（51 action、`news.*` 接口）」和「路径写死起不来、错误被吞」两次真机问题，
    还要求每次会话多养一个常驻进程。现在改成：插件**在 DSH 进程内** `import` 仓库的
    `dist-server/l3.mjs`（`npm run build` 产出；源码更新了插件会用仓库自己的 esbuild 现编一次），
    建 `AppApi` + 一个只绑回环的 HTTP 端口（给面板 iframe），工具调用直连 `l3.invoke()`。
    没有登记表 ⇒ 「复用旧实例」这整类问题从根上消失；DSH 一退，进程内的一切随之结束。
    两条逃生通道都保留：`AITM_URL`（外部实例，仍过 apiRev 护栏）、`AITM_L3=0`（旧的 spawn 桥）。
    **已知边界**：进程内之后**不再跨实例复用后端** —— 同时开两个 DSH（或 Electron 与 DSH 同时开）
    就是两个实例写同一份数据目录，落到文件层是「各自原子写、后写覆盖」。日常建议一次只开一个宿主；
    要做多宿主共享，下一步是加「L3 登记表复用（只复用同版本、同 apiRev 的 L3）」。
    面板产物（`dist/index.html`）缺了或旧了，插件会用 `npx vite build` 一次性补（不是常驻进程）。

12. **（旧桥通道：`AITM_L3=0` 或外部实例）后端会被「复用」，所以必须核身份**：旧桥按 `%TEMP%/aitm-dsh-backend.json` 复用上一次
   会话留下的后端（多个 DSH 会话共用一个实例，不叠着起）。但**复用的实例可能是旧版**——实测
   踩到过：DSH 接过一个 `0.1.0-m1` 的旧后端（接口还叫 `news.get`），面板显示 51 个 action，
   `aitm_feed_today` 当场报「未知接口：feed.get」。
   现在两边对齐了：核心在 `GET /api/health` 里报 `apiRev`（`src/shared/api-rev.ts`，改接口名/入参
   就 +1），插件 `REQUIRED_API_REV` 对不上就**拒绝复用/拒绝连接**，错误里直接写清「连的是谁、
   差在哪、怎么处理」；设置节也会把版本 + 数据目录摊开显示。
   另：`version` 字段是 `npm_package_version`，本项目长期是 `0.1.0`，**别拿它当版本判据**，认 `apiRev`。

13. **别写死仓库路径，也别把子进程的错误吞掉**（2026-10-05 真机「不能拉起后端」）：
   早期版本 `AITM_REPO` 默认值写的是开发机的 `/home/user/ai-tasks-mgr` —— 换到 Windows 就变成
   「去一个不存在的目录起后端」，而 `stdio:'ignore'` 把 spawn 的错误也吞了，用户只看到
   「后端没起来」。现在：① 仓库默认**按插件自身位置推导**（`path.resolve(PLUGIN_DIR, '..')`，
   插件就在仓库里）；② 起之前自检仓库（目录 / `package.json` 名字 / `scripts/dev-web.mjs` /
   `node_modules/vite`），不合格**当场**报「哪个路径、缺什么、怎么修」；③ 看门狗把后端
   stdout/stderr 追进 `%TEMP%/aitm-dsh-backend.log`，失败时把尾巴贴进错误与面板；
   ④ spawn 的 `'error'` 事件接住，不再空等 90 秒超时；⑤ `node scripts/doctor.mjs` 一条命令
   把上面全打出来。

14. **分发模式：包里自带内核，机器上不需要仓库**（M3 第一半，2026-10-06）：后端来法收进**一个**
    决策函数（`backendPlan()`）：`AITM_URL` → external；仓库自检过 → l3（仓库内）；没有仓库但包里
    有 `dist-server/l3.mjs` → **vendor**；`AITM_L3=0` → 旧 spawn 桥；**显式设了 `AITM_REPO` 却没
    过自检 → 报错**（用户要的就是那个仓库，不能悄悄换成自带内核）。自带内核模式的数据目录走
    `AI_TASKS_HOME` → `~/.ai-tasks-mgr`（仓库模式仍是 `<repo>/.aitasks`，真机那份数据在那儿）。
    小坑：`AITM_REPO` 的**空串当没设**（Windows 上 `set AITM_REPO=` 就是空串，否则会变成「仓库是空路径」）。
15. **作为 profile bundle 安装，补丁里的 `name:` 要用包名**：`dsh plugin add` 之后 DSH 是按
    `package.json` 的 `dsh.profile.bundles` 加载的，我们那条 row 由 `dsh.bundle.patch` 指到的
    `aitm.bundle.patch.yml` 插进去 —— 里面写 `name: dsh-plugin-aitm`（包已装在 profile 的
    node_modules 里，由 Cordis loader 解析）。开发路径的 `aitm.patch.yml` 写**绝对路径**（没装包，
    只能指文件）。**两个文件别混用**：patch 的 `name:` 缺 `dsh.bundle` 声明时会报
    `declares no dsh.bundle`，整个 bundle 被跳过（实测踩到，插件根本不激活）。
16. **别把 `@deepseek-ai/dsh-tools` 当运行期依赖**（2026-10-06 实测）：我们也觉得「import 了就该
    声明 dependency」，结果 profile 的 node_modules 里多出第二份 —— DSH 自己的 agent-loop 会从
    profile 解析到**那一份**，于是同一个包两个实例、靠 **Symbol 注册**的服务查不到，工具调用直接失败
    （`Cannot read properties of undefined (reading 'prepare')`）。宿主本来就提供它，所以：**devDependencies
    里留着给离线渲染用，运行期一份都不许带**（verify-dist 专门断言 tarball 里没有 `node_modules/`）。
    peer 声明 `@deepseek-ai/dsh`（DSH 的版本兼容闸门读它：对不上会要 `dsh plugin allow-version`）。

17. **`jsx/jsxs` 的第三个参数是 `key`，不是孩子**（2026-10-06 写原生看板时踩的）：DSH 注入的是
    `react/jsx-runtime` 的 `jsx(type, props, key)` —— 孩子必须放进 `props.children`。写成
    `jsx('div', {}, child)` 不报错也不警告，只是渲染出一个**空 div**（当时现象：看板 7 个 `data-col`
    都在、卡片一张都没有）。离线渲染（`renderToStaticMarkup` + `verify-dsh`）一眼能看出来，别只在真机瞎猜。

## 面板里放什么

- **看板页原生**：右侧栏的「看板」是插件的 React 组件（七列 + 卡片 + 拖拽 + 原生详情），见上面的工具卡一节。
- **日历页原生**：右侧栏的「日历」同上（月历 + 当天明细），点想法回看板摊详情。
- 只剩两处 iframe：**「合集」这一页**，以及详情页里的**「在完整面板里打开」**（那里有对话/差异/属性，
  属于完整面板的活）。iframe 打的是 `?embed=1&view=<board|feed>`：
  - `embed=1` 让我们界面**隐藏自己的侧栏和顶栏**（否则 DSH 里会出现两层导航）；
  - 自带一条极简切换（看板 / 日历 / 合集）；
  - `&idea=<id>` 是深链：打开面板时直接落在那条想法的详情上（详情页「在完整面板里打开」就走它）。

## 已知边界

- **看板与日历已原生**（React，不再 iframe）；**合集**仍是 iframe —— 逐页改造还在继续。
- 后端默认是**进程内 L3**（M2 第三步）：内核跑在 DSH 自己的进程里，只留一个回环端口给 iframe；
  **不再 spawn 常驻后端**（所以也没有「复用旧实例」「关不掉的孤儿进程」这两类问题了）。
  两条逃生通道：`AITM_URL=<地址>` 连外部实例（保留旧后端护栏）、`AITM_L3=0` 退回 M1 的 spawn 桥。
- 写操作 4 个（记想法 / 改状态 / 开工 / 备份）：一律走 `tools/pre-execute` 审批，缺参直接 deny；
  开工走的是核心 runner 的 fail-fast（想法不存在 / 没绑仓库 / 已有进行中的任务都会带原因返回）。
- 工具卡在**刷新会话后**才吃到 meta（meta 随会话记录走）；老会话里的调用只有原始文本。
