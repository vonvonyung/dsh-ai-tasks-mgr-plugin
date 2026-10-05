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
node scripts/verify-dsh.mjs     # ① 离线渲染 ② 激活 ③ boot 图+分片送达 ④ 端到端真数据
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

## 面板里放什么

iframe 打的是 `?embed=1&view=<board|calendar|feed>`：
- `embed=1` 让我们界面**隐藏自己的侧栏和顶栏**（否则 DSH 里会出现两层导航）；
- 自带一条极简切换（看板 / 日历 / 合集）。

## 已知边界（M1）

- 面板是 **iframe**（先拿到"看得见"，M2 逐页改成 DSH 插槽原生组件）。
- 插件会**按需拉起**我们的 web 宿主（只在回环上）；DSH 退出时一起收掉。
- 只读：写操作（记想法/开工）在 M2 才开，届时危险动作走 `tools/pre-execute` 审批。
