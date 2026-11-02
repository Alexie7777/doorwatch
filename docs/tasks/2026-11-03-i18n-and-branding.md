# 任务规格 · 中英切换 + 页脚改版 + 文案调整

> 状态:**待执行**
> 提出时间:2026-11-02 21:40
> 计划执行时间:2026-11-03 00:00(定时任务)
> 项目:`/srv/doorwatch`(GitHub `Alexie7777/doorwatch`,分支 `main`)

---

## 0. 背景

看板(`doorwatch`)是给国际学校 IT 部门用的「IT 办公室是否关门」手机看板。
现在的界面**全是中文**,但学校里外籍老师多,需要能切英文。

同时页脚底部那行「管理 v1.0.0」用户觉得不想要,换成品牌署名。

> ⚠️ **动手前先读这一段**
> 本项目有一条不可妥协的底线:**看板显示的必须是真的**。
> 传感器离线时必须显示「状态未知」,不能显示过期状态。
> 任何时候都不要为了"看起来正常"而牺牲这条。
>
> 另外:本仓库的约定 —— 改完代码要跑 `npm run check` 和 `npm test`,
> 两者都必须全绿;要提交并推送;文档(`README.md` / `ha/README.md` / `ha/CHECKLIST.md`)
> 要跟着改。

---

## 1. 三件事

### ① 中英切换(主要工作量)

### ② 页脚:「管理 v1.0.0」→「Powered By IT Dept」

### ③ 关门提示文案改字

---

## 2. ① 中英切换 · 详细设计

### 2.1 语言状态

- 存在 `localStorage`,键名 `dw_lang`,取值 `'zh'` | `'en'`
- 默认 `'zh'`(用户是中文学校,默认中文最稳妥)
- 切换按钮的标签显示**另一种语言的名字**(中文界面显示 `EN`,英文界面显示 `中`)

### 2.2 切换按钮放哪

放**页头右上角**,在连接状态圆点按钮的左边。
理由见 §2.7 —— 页脚腾出来给 "Powered By IT Dept" 了,但「管理」入口不能丢。

```html
<!-- public/index.html,header 里 -->
<div class="topbar__actions">
  <button class="topbar__lang" id="lang-toggle" type="button" aria-label="Switch language">EN</button>
  <button class="topbar__refresh" id="refresh" type="button" aria-label="刷新">
    <span class="dot" id="conn-dot"></span>
  </button>
</div>
```

样式跟着 `public/style.css` 里现成的 `.topbar__refresh` 写一个 `.topbar__lang`
(小一点、圆角、用 `--text-dim` / `--line` 那套变量,别用新的颜色)。

### 2.3 字典放哪

**新建 `public/i18n.js`**,导出:

```js
export const LANGS = ['zh', 'en'];
export function getLang() { ... }                 // 读 localStorage,默认 'zh'
export function setLang(lang) { ... }             // 写 localStorage + 通知订阅者
export function t(key, vars) { ... }              // 取当前语言的文案
export function onLangChange(fn) { ... }          // 订阅语言变化
```

字典内容见 §2.6 的对照表。**所有面向用户的文案都必须走 `t()`**,
不允许在模板里硬编码中文。

### 2.4 服务端要给两套文案

现在门的名称、位置、提示语都是服务端发下来的中文(`hints.open` / `hints.closed` /
`hints.unknown`)。英文界面也得有对应的,所以服务端要同时发两套。

#### `config/doors.json` 每扇门新增可选字段

```json
{
  "id": "it-office",
  "name": "IT 办公室",
  "nameEn": "IT Office",
  "location": "A512",
  "locationEn": "A512",
  "deviceId": "it-office-door",
  "openHint": "IT 有人在,直接过来就行",
  "openHintEn": "Someone from IT is in — just come over",
  "closedHint": "门已关，IT 暂时不在，可联系值班微信",
  "closedHintEn": "Door closed, IT is temporarily away. Contact the on-duty WeChat.",
  "unknownHint": "传感器没上线,状态未知 —— 请先联系 IT",
  "unknownHintEn": "Sensor offline, status unknown — please contact IT"
}
```

- `*En` / `unknownHint*` **都是可选的**;缺了就回退到中文那份(而不是空白)
- `unknownHint` 现在是写死在 `server/src/state.js` 里的,顺手也挪进 `doors.json`,
  这样每扇门都能定制;不填就沿用现在那句

#### `server/src/db.js`

- `doors` 表加 6 列:
  `name_en` / `location_en` / `open_hint_en` / `closed_hint_en` / `unknown_hint` / `unknown_hint_en`
- **必须写老库迁移** ——照抄 battery 那次的老实做法:

  > `CREATE TABLE IF NOT EXISTS` 对**已存在的表**不会加列。
  > 必须 `PRAGMA table_info(doors)` 查一遍,缺哪列 `ALTER TABLE doors ADD COLUMN` 补哪列。
  > 幂等,反复跑没副作用。

- `syncRegistry` 的 upsert 要把新列一起写上
- `normalize`(在 `server/src/doors.js`)把新字段读出来,缺省回退到中文那份

#### `server/src/state.js` 的 `toPublic`

输出改成这样(`hints` 保留不动,免得破坏已有测试和文档):

```js
i18n: {
  zh: {
    name: door.name,
    location: door.location,
    open: door.open_hint,
    closed: door.closed_hint,
    unknown: door.unknown_hint || '传感器没上线,状态未知 —— 请先联系 IT',
  },
  en: {
    name: door.name_en || door.name,
    location: door.location_en || door.location,
    open: door.open_hint_en || door.open_hint,
    closed: door.closed_hint_en || door.closed_hint,
    unknown: door.unknown_hint_en || door.unknown_hint || '...',
  },
},
```

**英文那份全部回退到中文**,保证任何时候都不会出现空白。

#### `server/src/index.js` 的错误响应加 `errorKey`

现在错误只回 `{ error: '中文' }`,客户端没法翻译。改成:

```js
json(res, 401, { error: '需要管理密钥', errorKey: 'need_admin_key' });
```

涉及的错误(照现有那几处改):

| errorKey | 中文 | English |
|---|---|---|
| `need_admin_key` | 需要管理密钥 | Admin key required |
| `bad_admin_key` | 管理密钥不正确 | Incorrect admin key |
| `bad_json` | 请求体不是合法 JSON | Request body is not valid JSON |
| `bad_state` | state 必须是 open 或 closed | state must be open or closed |
| `no_such_door` | 没有这扇门 | No such door |
| `api_not_found` | 接口不存在 | Endpoint not found |
| `server_error` | 服务器内部错误 | Internal server error |

客户端按 `errorKey` 翻译;拿不到 `errorKey` 就退回原始 `error` 文本。

### 2.5 客户端怎么用

```js
// public/app.js
import { getLang, setLang, t, onLangChange } from './i18n.js';

// 初始化
document.documentElement.lang = getLang() === 'en' ? 'en' : 'zh';

// 切换按钮
$('#lang-toggle').addEventListener('click', () => {
  setLang(getLang() === 'zh' ? 'en' : 'zh');
});

// 语言变了:重画整页
onLangChange(() => {
  document.documentElement.lang = getLang() === 'en' ? 'en' : 'zh';
  $('#lang-toggle').textContent = getLang() === 'zh' ? 'EN' : '中';
  render();
  renderManageBody();   // 管理面板也要跟着变
});
```

**门的名称/位置/提示语**这样取:

```js
const loc = getLang() === 'en'
  ? (door.i18n?.en ?? door)
  : (door.i18n?.zh ?? door);
const name = loc.name ?? door.name;
const hint = loc[meta.cls] ?? door.hints?.[meta.cls] ?? '';
```

### 2.6 文案对照表(必须全覆盖)

**页面主体**

| key | 中文 | English |
|---|---|---|
| `pageTitle` | IT 办公室状态 | IT Office Status |
| `appTitle` | IT 办公室 | IT Office |
| `statusTitle` | IT 在岗状态 | IT Office Status |
| `connecting` | 正在连接… | Connecting… |
| `subOpen` | 有人值班,可以直接过去 | Someone from IT is in — feel free to go over |
| `subNone` | 暂无人在办公室 | No one is in the office right now |
| `subUnknown` | N 个门状态未知 | N door(s) with unknown status |
| `disconnected` | 连接断开,正在重试… | Connection lost, reconnecting… |
| `stateOpen` | 门开着 | Door Open |
| `stateClosed` | 门关着 | Door Closed |
| `stateUnknown` | 状态未知 | Unknown |
| `badgeOnline` | 传感器在线 | Sensor Online |
| `badgeOffline` | 传感器离线 | Sensor Offline |
| `badgeOverride` | 人工置顶 | Manual Override |
| `battery` | 电量 {n}% | Battery {n}% |
| `lastChange` | 最后变化 | Last change |
| `heartbeat` | 心跳 | Heartbeat |
| `today` | 今天:开 {open} 次 / 关 {close} 次 | Today: {open} open / {close} closed |
| `now` | 现在 | Now |
| `footerHint` | 出门前扫一眼,省下一趟白跑。 | Take a look before you head over — save yourself a wasted trip. |
| `poweredBy` | Powered By IT Dept | Powered By IT Dept |

**相对时间**(`relTime`,键名可自定,但单位要分清)

| 中文 | English |
|---|---|
| 刚刚 | just now |
| {n} 秒前 | {n}s ago |
| {n} 分钟前 | {n}m ago |
| {n} 小时前 | {n}h ago |
| 昨天 | yesterday |
| {n} 天前 | {n}d ago |
| 无记录 | no record |
| 已隐藏 | hidden |

**管理面板**

| key | 中文 | English |
|---|---|---|
| `manage` | 管理 | Manage |
| `manageHelp` | 输入管理密钥(服务器 data/ADMIN_KEY.txt 里那个)以解锁写操作。 | Enter the admin key (the one in the server's `data/ADMIN_KEY.txt`) to unlock write operations. |
| `adminKeyPlaceholder` | 管理密钥 | Admin key |
| `unlock` | 解锁 | Unlock |
| `needKey` | 请输入密钥 | Please enter the key |
| `badKey` | 密钥不正确 | Incorrect key |
| `unlocked` | 已解锁 | Unlocked |
| `unlockedHelp` | 已解锁。置顶用于特殊情况(如全员出差),会覆盖传感器状态。 | Unlocked. Override is for special cases (e.g. everyone is away) and overrides the sensor state. |
| `overrideClosed` | 置顶为关门 4 小时 | Override: Closed for 4h |
| `overrideOpen` | 置顶为开门 4 小时 | Override: Open for 4h |
| `clearOverride` | 取消置顶 | Clear override |
| `close` | 关闭 | Close |
| `langSwitch` | 切换语言 | Switch language |

**门的提示语**(服务端下发,见 §2.4)

### 2.7 页脚 & 「管理」按钮的去向

**页脚底部改成只有一行品牌署名**:

```html
<footer class="footer">
  <p class="footer__hint" id="footer-hint">…</p>
  <p class="footer__brand" id="footer-brand">Powered By IT Dept</p>
</footer>
```

- 删掉 `<span class="footer__ver" id="version"></span>`
- 删掉 `public/app.js` 里那段 fetch `/api/health` 填版本号的代码
  (版本号还在 `/api/health` 里,只是页面上不显示了)
- 「管理」按钮**从页脚移到页头**(见 §2.2 的 `topbar__actions`),
  免得「人工置顶」这个功能没有入口

> ★ 这条是本规格里唯一带主观判断的地方:
> 用户说「把『管理 v1.0.0』删掉,换成 Powered By IT Dept」。
> 直接删掉「管理」会让**人工置顶功能没有入口**(全员出差时钉死"别来"就废了),
> 所以按「页脚只留品牌署名 + 管理按钮挪到页头」处理。
> 如果实现时发现用户其实想保留页脚的管理入口,挪回去就行,其它不受影响。

---

## 3. ③ 关门提示文案

`config/doors.json` 里 IT 办公室这一条:

```json
"closedHint": "门已关，IT 暂时不在，可联系值班微信",
"closedHintEn": "Door closed, IT is temporarily away. Contact the on-duty WeChat.",
```

- 注意用户给的是**全角逗号「，」**,照抄,不要用半角
- `server/src/doors.js` 的 `DEFAULT_DOORS` 里那句也一起改掉
- `README.md` / `ha/README.md` / `ha/CHECKLIST.md` 里引用了旧文案的地方一并更新

---

## 4. 要改的文件(清单)

| 文件 | 改什么 |
|---|---|
| `public/i18n.js` | **新建** —— 字典 + 语言状态 |
| `public/app.js` | 所有文案走 `t()`;加语言切换;门名/提示语取 `i18n`;页脚改版 |
| `public/index.html` | 页脚结构;页头加语言按钮和管理按钮;`<title>` |
| `public/style.css` | `.topbar__actions` / `.topbar__lang` / `.footer__brand` 样式 |
| `server/src/state.js` | `toPublic` 输出 `i18n` 两套 |
| `server/src/db.js` | `doors` 表加 6 列 + 老库迁移 + `syncRegistry` 写新列 |
| `server/src/doors.js` | `normalize` 读新字段;`DEFAULT_DOORS` 更新文案 |
| `server/src/index.js` | 错误响应加 `errorKey` |
| `config/doors.json` | 新字段 + 新文案 |
| `test/freshness.mjs` | 加断言:迁移后新列存在;`toPublic` 的 `i18n` 两套都对;英文缺字段时回退中文 |
| `test/ui.mjs` | 加断言:点切换按钮后页面文案变英文;`documentElement.lang` 跟着变;页脚显示 `Powered By IT Dept`;页脚**没有**「管理」和版本号 |
| `README.md` / `ha/README.md` / `ha/CHECKLIST.md` | 文档同步 |

---

## 5. 验收标准

必须全部满足:

1. `npm run check` 退出码 0
2. `npm test` 退出码 0(所有测试组全绿)
3. `npm run check:ha-templates` 通过(本任务不该影响 HA 模板,但别改坏)
4. **UI 测试里加的断言要真的验证过**:
   - 点 `EN` → 页面上「门开着」变成「Door Open」
   - `document.documentElement.lang` 变成 `'en'`
   - 再点一次 → 变回中文
   - 页脚显示 `Powered By IT Dept`,且**不再有**「管理」和 `v1.0.0`
   - 语言选择刷新后还在(靠 `localStorage`)
5. **必须用 Chrome headless + CDP 真的截一张图**,两种语言各一张,
   放在 `test/artifacts/` 下,自己看一眼确认没排版错乱
   (仓库里有现成的 CDP 写法可以抄 `test/ui.mjs`;`tools/shoot.mjs` 只能截静态页)
6. 提交并推送到 `origin/main`,提交信息写清楚三件事分别做了什么

---

## 6. 部署(改完之后告诉用户)

```bash
cd /srv/doorwatch && git pull
cd deploy && docker compose up -d --build
```

⚠️ **手机上要重新加载一次**才能拿到新的 JS/SW(Service Worker 有缓存):
关掉页面重开,或者下拉刷新;实在不行清一下站点数据。

---

## 7. 完成后怎么汇报

用中文,回答里要有:

- 三件事各自做了什么(一句话一条)
- **中文 / 英文两张看板截图**(用 `<deliver-assets>` 包 `<media />`)
- 跑过哪些命令、结果如何
- 提交号
- 需要用户做的部署步骤
