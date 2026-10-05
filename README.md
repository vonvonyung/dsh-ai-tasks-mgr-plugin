# dsh-plugin-aitm · AI 任务台 × DeepSeek Harness 插件

把 AI 任务台接进 DSH 客户端的最小插件（M1：**只读**）。

```
┌─ DSH 客户端 ────────────────────────────────┐
│  右侧栏：AI 任务台面板（iframe → 我们界面）   │  ← 人看
│  对话：模型调用 aitm_health / idea_list / …   │  ← 模型用
│  设置：AI 任务台（后端地址 + 健康状态）        │  ← 运维
└─────────────────────────────────────────────┘
                    │
                    ▼  本机回环（只绑 127.0.0.1）
     现有 web 宿主：node scripts/dev-web.mjs --prod
     （M2 会换成插件进程内的 L3 服务，插件接口不变）
```

## 装（三步，开发期不需要 pnpm）

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
   | `AITM_DEBUG` | `1` = 接住子进程日志（**会让 headless 不退出，只在手工调试时开**） | 空 |

## 三个只读工具（模型可调用）

| 工具 | 干的事 |
|---|---|
| `aitm_health` | 后端健康：action 数 / 数据目录 / 后端地址（面板打不开先调它） |
| `aitm_idea_list` | 列想法（status / q / limit，默认 20 条）+ 各状态计数 |
| `aitm_feed_today` | 今日热榜条数与收藏数（读快照，不触发抓取） |

## 验证

```bash
node scripts/verify-dsh.mjs     # 14 项：离线渲染 + 挂点护栏（不占 rightbar）+ 旧后端护栏 + 起前自检 + 激活 + boot 图 + 分片送达 + 端到端真数据
node scripts/doctor.mjs         # 体检（不用起 DSH）：在哪个目录起后端、缺什么、后端日志尾巴
```

## 实现要点（踩过的坑，别踩第二遍）

1. **插件的长驻子进程会把 DSH「钉」住**：`dsh headless` 跑完一轮也不退出（实测卡到超时）。
   解法：spawn 时 `stdio: 'ignore'` + `child.unref()`，并在 `process.once('exit')` 里收掉它。
   （调试要日志就 `AITM_DEBUG=1`，那会重新接管道、headless 就不会自己退了 —— 只在手工调试时开。）
2. **`/api/health` 是路由，不是 action**：它不走 `POST /api/<action>` 那套信封，要 `GET` 直取。
3. **patch 只能定位已有 id**：新增插件用**不带 id** 的 `insert:`（带 id 的 insert 是往那个 group 里追加）。
4. **工具输出 schema 的 `required` 写在属性上**（对象级 `required` 会在激活期抛 `JsonSchemaError`）。
5. **launcher 参数必须排在 app 参数前**：`--profile/--patch` 在 `--json` 之前。
6. **客户端半边看不见 Node**：后端地址走宿主半边注册的 `/aitm-plugin/config`（同源 fetch）。
7. **别碰 `rightbar` —— 那是「座位」单占位槽**（R9 白屏事故根因）。DSH 自己的
   `@deepseek-ai/dsh-client-ui-sidebar-right` 要注册 `rightbar`；谁先注册，第二个就在 apply 里抛
   `single slot "rightbar" already has a registration at priority 0` → 对方 failed → 依赖它的
   `sessions/uiSession` 全 pending → `web boot: N entries did not activate` + 白屏。
   **正确挂法＝注册自己的右侧栏页签类型**（下一条）。
8. **右侧栏页签扩展点（三条一起才生效）**：
   ```js
   ctx.sidebarRightTabs.register({ id: 'dsh-plugin-aitm', kind: 'aitm', priority: 'extension',
     multiple: false, title: () => 'AI 任务台',
     guide: [{ id: 'open', order: 40, title: () => 'AI 任务台', description: () => '…' }] });
   ctx.slots.inject('sidebar.right.pane.tab',       () => ctx.slots.register({ name: 'sidebar.right.pane.tab',       key: 'dsh-plugin-aitm' }, Body));
   ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: 'dsh-plugin-aitm' }, Title));
   ```
   两个 keyed 槽的 `key` ＝ 类型的 **`id`**（不是 `kind`）；开面板用 `ctx.sidebarRight.openTab('<kind>')`
   （`openTab` 属于「当前会话」，没有会话时不要调；用户也能从右侧栏的引导页点进来）。

9. **后端会被「复用」，所以必须核身份**：插件默认按 `%TEMP%/aitm-dsh-backend.json` 复用上一次
   会话留下的后端（多个 DSH 会话共用一个实例，不叠着起）。但**复用的实例可能是旧版**——实测
   踩到过：DSH 接过一个 `0.1.0-m1` 的旧后端（接口还叫 `news.get`），面板显示 51 个 action，
   `aitm_feed_today` 当场报「未知接口：feed.get」。
   现在两边对齐了：核心在 `GET /api/health` 里报 `apiRev`（`src/shared/api-rev.ts`，改接口名/入参
   就 +1），插件 `REQUIRED_API_REV` 对不上就**拒绝复用/拒绝连接**，错误里直接写清「连的是谁、
   差在哪、怎么处理」；设置节也会把版本 + 数据目录摊开显示。
   另：`version` 字段是 `npm_package_version`，本项目长期是 `0.1.0`，**别拿它当版本判据**，认 `apiRev`。

10. **别写死仓库路径，也别把子进程的错误吞掉**（2026-10-05 真机「不能拉起后端」）：
   早期版本 `AITM_REPO` 默认值写的是开发机的 `/home/user/ai-tasks-mgr` —— 换到 Windows 就变成
   「去一个不存在的目录起后端」，而 `stdio:'ignore'` 把 spawn 的错误也吞了，用户只看到
   「后端没起来」。现在：① 仓库默认**按插件自身位置推导**（`path.resolve(PLUGIN_DIR, '..')`，
   插件就在仓库里）；② 起之前自检仓库（目录 / `package.json` 名字 / `scripts/dev-web.mjs` /
   `node_modules/vite`），不合格**当场**报「哪个路径、缺什么、怎么修」；③ 看门狗把后端
   stdout/stderr 追进 `%TEMP%/aitm-dsh-backend.log`，失败时把尾巴贴进错误与面板；
   ④ spawn 的 `'error'` 事件接住，不再空等 90 秒超时；⑤ `node scripts/doctor.mjs` 一条命令
   把上面全打出来。

## 面板里放什么

iframe 打的是 `?embed=1&view=<board|calendar|feed>`：
- `embed=1` 让我们界面**隐藏自己的侧栏和顶栏**（否则 DSH 里会出现两层导航）；
- 自带一条极简切换（看板 / 日历 / 合集）。

## 已知边界（M1）

- 面板是 **iframe**（先拿到"看得见"，M2 逐页改成 DSH 插槽原生组件）。
- 插件会**按需拉起**我们的 web 宿主（只在回环上）；DSH 退出时一起收掉。
- 只读：写操作（记想法/开工）在 M2 才开，届时危险动作走 `tools/pre-execute` 审批。
