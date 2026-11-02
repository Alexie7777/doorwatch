# 门磁已接入 HA —— 之后的落地顺序

> 门磁已经在 Home Assistant 里能看到状态了。接下来要把它接到 doorwatch 看板,
> 中间隔着三样必须对齐的东西:**实体名**、**deviceId**、**方向**。
>
> 这份清单照着做,大概 30 分钟。做完最后一步,手机上看板就会跟着门动。

---

## 全景

```
 门磁 ──蓝牙──> 米家网关 ──WiFi──> 米家云 ──> Home Assistant
                                                  │
                                          xiaomi_miot 集成
                                                  │
                                    模板归一化(OPEN/CLOSED/UNKNOWN)
                                                  │
                                          MQTT(doorwatch/<deviceId>/…)
                                                  │
                                    doorwatch 服务端(内置 broker)
                                                  │
                                         手机看板(https)
```

两边要对齐的就三处:

| 要对齐的东西 | 在哪 | 写什么 |
|---|---|---|
| 门磁实体名 | `ha/templates.yaml` | `binary_sensor.你的门磁` |
| deviceId | `ha/automations.yaml` 主题后缀 + `config/doors.json` | `it-office-door`(两边必须一模一样) |
| 方向 | `ha/templates.yaml` 的 `DOOR_ON_MEANS_OPEN` | `true` = HA 里 `on` 表示门开着 |

---

## 第 0 步 先跑一次体检(1 分钟)

在装 HA 那套配置**之前**先跑一次,免得装完了不知道断在哪:

```bash
cd /srv/doorwatch
node tools/doctor.mjs --doorwatch https://<你的服务器>:8443 --insecure
```

它会查 5 环(服务端 → MQTT → 看板 → HA 模板 → deviceId 对齐),
并直接告诉你断在哪一环、接下来该敲哪条命令。

看板一直显示「状态未知」时,**先跑这个**,不要瞎猜。

带上 HA 一起查(推荐,能多查两样东西):

```bash
node tools/doctor.mjs \
  --doorwatch https://<你的服务器>:8443 --insecure \
  --ha http://<你的HA>:8123 --token <TOKEN>
```

多查的两样是:

| 检查 | 它做什么 | 什么时候看它 |
|---|---|---|
| **现场渲染** | 把本仓库 `ha/templates.yaml` 里的模板**直接 POST 给 HA 的 `/api/template`**,看它此刻渲染成什么 | **装配置之前就该跑一次** —— 能在改 HA 配置之前就确认这份模板在你这台 HA 上不会炸 |
| **保险丝求值** | 把 `ha/automations.yaml` 里那段「传感器还活着吗」的 Jinja 在 HA 上**算一遍**,直接告诉你通过还是不通过 | 看板一直显示「状态未知」时**先看这个** —— 不通过 = 每分钟都推 offline,看板永远未知 |
| **错误日志** | 抓 HA 的 `/api/error_log`,把跟 doorwatch 有关的报错原文打出来 | 实体显示 `unavailable` 时,它会直接告诉你**是哪一行模板抛的异常** |
| **时间戳对照** | 把原始门磁、状态模板、可读性模板的 `last_reported` 并排列出来 | 想知道「哪个时间戳能用来判死活」—— 原始门磁的在推进,模板实体的**冻结着** |

> token 在 HA 里拿:**左下角头像 → 安全 → 长期访问令牌 → 创建令牌**。
> HA 默认是 **http**,写成 https 的话工具会自己降级重试。

---

## 第 1 步 确认实体名和方向(2 分钟)

门磁接进 HA 后,大概率会冒出来一堆实体:门磁、运动、人体、照度、电量……
名字还带厂商前缀。**必须用 `device_class=door` 那个**,不是运动那个。

### 用探针脚本(推荐)

```bash
node tools/ha-probe.mjs --host http://homeassistant.local:8123 --token <TOKEN>
```

token 在 HA 里拿:**左下角头像 → 安全 → 长期访问令牌 → 创建令牌**。
(也可以设环境变量 `HA_TOKEN`,脚本就不必带 `--token` 了。)

输出长这样:

```
HA: http://homeassistant.local:8123
版本: 2026.10.4

=== 门磁候选实体(2 个)===

  binary_sensor.isa_dw2hl_b95b_magnet_sensor
      state=off  device_class=door  「门磁」
      last_changed  3 分钟前
      last_updated  3 分钟前   ← 状态/属性变化才动
      last_reported 8 秒前     ← 集成每轮写一次就动
```

加上 `--watch 120` 再等两分钟,它会告诉你这两个时间戳到底哪个在推进。
这一步很关键,原因见第 6 步。

### 手动找

HA → **设置 → 工具 → 状态**,搜 `door` / `magnet` / `contact` / `门`。
记下 `entity_id`(比如 `binary_sensor.isa_dw2hl_b95b_magnet_sensor`)。

### 验方向

物理上把门打开,看这个实体的状态变成什么:

| 开门时实体变成 | 说明 | `DOOR_ON_MEANS_OPEN` |
|---|---|---|
| `on` | HA 里 `on` = 门开着 | `true`(默认) |
| `off` | HA 里 `on` = 门关着,反了 | `false` |

> 用 `xiaomi_miot` 时默认就是 `on` = 门开着:集成识别到 `magnet-sensor` 服务 +
> `contact-state` 属性时会自动把状态反转,并把设备类型标成 `door`。
> 但不同型号、不同固件版本仍可能不一样,**现场开一次门最保险**。

---

## 第 2 步 HA 里加 MQTT 集成(3 分钟)

HA 要通过 MQTT 把状态推给 doorwatch。doorwatch 自带 broker,不用另外装 Mosquitto。

HA → **设置 → 集成 → 添加集成 → MQTT**,填:

| 字段 | 填什么 |
|---|---|
| Broker | doorwatch 服务器的 IP,例如 `192.168.1.50` |
| Port | `1883` |
| Username | 留空(内置 broker 不校验用户名密码) |
| Password | 留空 |

点 **提交**,显示"成功"就对了。

> 如果 doorwatch 用的是外部 broker(设了 `MQTT_HOST`),
> 这里就填那个 broker 的地址和账号密码。

---

## 第 3 步 装模板和自动化(5 分钟)

### 3.1 把两个文件放进 HA 的配置目录

| HA 安装方式 | 怎么放 |
|---|---|
| HA OS / Supervised | 装 **File Editor** 插件 → 打开 `/config` → 新建 `templates.yaml`、`automations.yaml`,内容从本仓库 `ha/` 目录复制过去 |
| Container / Core | 挂载到 HA 容器的 `/config/` 下,**见下面的完整写法** |

#### HA 跑在 Docker 里的话,挂载这样写

⚠️ **挂载目标必须写完整的文件路径,不能只写 `/config`。**
只写 `/config` 会报这个错:

```
not a directory: Are you trying to mount a directory onto a file (or vice-versa)?
```

原因是 `/config` 在镜像里已经是个目录,把文件挂到目录上,类型对不上。

在 **HA 的** compose 文件里(不是 doorwatch 的)加:

```yaml
  homeassistant:
    image: ghcr.io/home-assistant/home-assistant:stable
    volumes:
      - ./config:/config            # HA 自己的配置目录(通常已有这行)
      - ../ha/templates.yaml:/config/templates.yaml:ro      # ← 注意是文件路径
      - ../ha/automations.yaml:/config/automations.yaml:ro  # ← 注意是文件路径
```

路径按你实际的目录结构调整(上面假设 compose 文件在 `doorwatch/deploy/`、HA 文件在 `doorwatch/ha/`)。

挂完进容器确认一下:

```bash
docker compose exec homeassistant ls -l /config/templates.yaml /config/automations.yaml
```

#### ⚠️ doorwatch 容器不需要这两个文件

`ha/*.yaml` 是给 **Home Assistant** 用的,doorwatch 服务端一行都不读它
(它只读 `config/doors.json`)。把这两个文件挂进 doorwatch 容器没有任何意义。

判断你挂错没有:报错里那个容器如果是 `doorwatch`,**把那两行 volumes 删掉**,
只保留 `doorwatch-data:/data`。

### 3.2 在 `configuration.yaml` 顶层加两行

```yaml
template: !include templates.yaml
automation: !include automations.yaml
```

⚠️ **光把文件放进去不够**,还得改 `configuration.yaml` 加这两行,否则 HA 根本不会加载它们。
改完 `configuration.yaml` 要**重启 HA**;只改 `automations.yaml` 的话在「自动化」页面
点右上角 ⋮ → 「重新加载」就行。

#### ⚠️ 两个 YAML 都必须是「裸列表」

`!include` 是把文件内容**直接塞到 `template:` / `automation:` 这个键的位置上**。
所以文件里如果还有一层 `template:`,HA 会报:

```
Invalid config for 'template' at templates.yaml, line 105:
'template' is an invalid option for 'template', check: template
```

本仓库的 `ha/templates.yaml` 和 `ha/automations.yaml` **都已经是裸列表**,
直接用就行,不要自己再套一层。

如果你想手动粘进 `configuration.yaml` 而不是用 `!include`,记得补上键名并整体缩进两格:

```yaml
template:
  - sensor:
      - name: "Doorwatch IT Office Door State"
        # ...下面整段往下缩进两格
```

### 3.3 改 `templates.yaml` 里的实体名

本仓库的 `templates.yaml` **已经填好了**这一处:

```yaml
{% set src = states.binary_sensor.isa_dw2hl_b95b_magnet_sensor %}
```

> ⚠️ 文件里有 **2 处**生效的 `{% set src = ... %}`,两个模板各一处,
> 读的是同一个实体 —— 只改一个的话,保险丝就废了。
> 换设备时全文件替换这一处。
>
> ⚠️ 别用 `binary_sensor.isa_dw2hl_b95b_contact_state`:
> 那是 MIoT 的原始属性(磁铁吸合 = 门关),极性相反而且没有 `device_class`。

方向不对的话,把 `DOOR_ON_MEANS_OPEN = true` 改成 `false`。

### 3.4 检查并重载

> 📌 **HA 2026 的位置变化**:「开发者工具」在 **2026.2** 被挪进「设置」,
> **2026.8** 改名为 **「工具」/ Tools**,地址 `/config/tools`。
> 2026.2 之后的版本**侧边栏里已经没有这一项**了 —— 不是你的错觉。
> 直接开 `http://<你的HA>:8123/config/tools` 即可,
> 老地址 `/developer-tools` 会自动跳转。
> 这一块**仅管理员可见**;侧边栏里连「工具」都没有的话,
> 去 设置 → 人员 把账号角色改成「管理员」。

- **设置 → 工具 → 配置(YAML)→ 检查配置**,绿了再往下走。有红叉先别重载。
- 改了 `configuration.yaml` → 需要**重启 HA**。
- 只改了 `automations.yaml` → **自动化 → 右上角 ⋮ → 重新加载**就行,不用重启。

### 3.5 确认模板活了

**设置 → 工具 → 状态**,搜 `doorwatch_it_office`:

- `sensor.doorwatch_it_office_door_state` 应该是 `OPEN` / `CLOSED` / `UNKNOWN`
- `binary_sensor.doorwatch_it_office_door_readable` 应该是 `on`(能读到)/ `off`(读不到)

两个都没有 → YAML 没装对,回 3.1 查。

实体显示 **`unavailable`** → 模板渲染抛异常了。跑一次体检,它会把
HA 报错原文直接打出来:

```bash
node tools/doctor.mjs --doorwatch https://<你的服务器>:8443 --insecure \
  --ha http://<你的HA>:8123 --token <TOKEN>
```

实体显示 `UNKNOWN`(而不是 `CLOSED`)→ 模板活着,但**读不到门磁**。
去看 `binary_sensor.isa_dw2hl_b95b_magnet_sensor` 在 HA 里是不是
`unavailable` —— 那是集成那边的问题,不是模板的问题。

---

## 第 4 步 确认 deviceId 对得上(2 分钟)

`config/doors.json` 里 IT 办公室这一条:

```json
{
  "id": "it-office",
  "name": "IT 办公室",
  "location": "A512",
  "deviceId": "it-office-door"
}
```

> `location` 就是看板上显示的位置,按你们学校实际写(`A512` 这种房间号就行)。
> **只有实际接了传感器的门才登记** —— 登记了却没有传感器,看板就会一直显示
> 「状态未知」。删掉不用的门,重启服务端即可(它会把数据库里的旧记录一并清掉)。
>
> 还想让看板能切英文的话,再加几个可选字段(不写就自动回退到中文,不会出错):
>
> ```json
> {
>   "id": "it-office",
>   "name": "IT 办公室",
>   "nameEn": "IT Office",
>   "location": "A512",
>   "locationEn": "A512",
>   "deviceId": "it-office-door",
>   "openHint": "IT 有人在,直接过来就行",
>   "openHintEn": "Someone from IT is in — just come over",
>   "closedHint": "门已关，IT 暂时不在，可联系值班微信",
>   "closedHintEn": "Door closed, IT is temporarily away. Contact the on-duty WeChat."
> }
> ```
>
> 看板上点页头的 `EN` 就能切英文,语言选择记在手机浏览器本地,不用每次切。

`ha/automations.yaml` 里发出去的主题:

```yaml
topic: "doorwatch/it-office-door/state"
```

**两边的 `it-office-door` 必须完全一致。** 不一致的话 doorwatch 服务端会打印
"收到未登记设备" 的告警,然后把消息丢掉,看板永远不动。

本仓库现在这两个地方已经是对齐的,不用改;以后加第二扇门才需要动。

---

## 第 5 步 把服务端跑起来(5 分钟)

```bash
cd doorwatch/deploy
docker compose up -d
docker compose logs -f doorwatch
```

日志里应该看到:

```
[http] 看板已启动: https://192.168.1.50:8443
[mqtt] 内置 broker 已启动: 0.0.0.0:1883
```

手机浏览器打开 `https://<服务器IP>:8443`,自签证书会提示不安全,
点「高级 → 继续前往」。iOS Safari「分享 → 添加到主屏幕」就变成 App 图标了。

---

## 第 6 步 验收(10 分钟,6 个用例)

前两个用例过了,基本就成了。第三个开始是"不许撒谎"的验收。

| # | 做什么 | 期望结果 | 预期耗时 |
|---|---|---|---|
| 1 | 在 HA 里看 `sensor.doorwatch_it_office_door_state` | `CLOSED`(门关着) | 立即 |
| 2 | 把门打开 | 看板变「开着」;HA 模板变 `OPEN` | ≤ 30 秒(云端轮询延迟) |
| 3 | 关上门,等一分钟 | 看板变「已关」 | ≤ 30 秒 |
| 4 | **把蓝牙网关断电**(或让门磁不可达) | 看板变「状态未知」,**不能继续显示"开着/关着"** | ≤ 3 分钟 |
| 5 | 网关恢复供电 | 看板自动恢复真实状态 | ≤ 1 分钟 |
| 6 | 等一次电量上报自动化触发 | 看板上门磁旁边出现「电量 XX%」徽章 | ≤ 30 分钟 |

> 用例 6 没出现徽章?按顺序查这三样:
>
> ① **服务端是新版吗**(旧服务端不订阅 `battery` 主题,收到就丢):
> ```bash
> node tools/doctor.mjs --doorwatch https://<你的服务器>:8443 --insecure
> ```
> 看「服务端」那一环有没有 `已订阅 doorwatch/+/{state,status,heartbeat,battery}`。
>
> ② **HA 那条自动化加载了吗**:自动化页面应该看到「门磁电量 → doorwatch(IT 办公室)」,
> 一共 4 条。少了就是没贴进去。
>
> ③ **电量到底在哪个实体上**。HA 设置 → 工具 → 模板,粘这一行:
> ```jinja
> {% for id in states | list if 'isa_dw2hl' in id %}{{ id }} = {{ states[id].state }}
> {% endfor %}
> ```
> 会把这个设备的所有实体列出来。电量要么是主实体上的 `battery_level` 属性,
> 要么是一个独立的 `sensor.isa_dw2hl_b95b_battery_level` 实体 ——
> 本仓库的自动化**两种都认**,所以只要列表里能看到电量,就一定能取到。
>
> ④ 还不出的话,直接看服务端有没有收到:
> ```bash
> cd doorwatch/deploy && docker compose logs -f doorwatch | grep 电量
> ```
> 看到 `[mqtt] it-office-door 电量 -> 87%` 就说明服务端这边完全正常,
> 问题在 HA 那一侧。

### 用例 4 没过?先别慌,分清是哪种"死"

这是这套方案**最需要如实说明的一点**,请务必做完用例 4:

- **HA ↔ 米家云 断了**(断网 / 米家服务器抽风)
  → xiaomi_miot 连续 3 次云端请求失败后会把实体标成 `unavailable`
  → 看板正确地显示「状态未知」✅

- **门磁自己死了**(电池没了 / 门磁被拿走),但网关和云都正常
  → 云端会把**最后一次的值**继续返回给 HA
  → HA 这边实体一切正常,`last_reported` 一直在推进
  → **看板看不出门磁死了** ⚠️

第二种情况是**蓝牙 + 云端这条路线固有的局限**,不是 doorwatch 的 bug:
门磁不主动上报,云端就没有新数据可给。

三个可选对策:

1. **看电量**:Xiaomi MIoT 门磁带 `battery-level`,HA 实体属性里就有。
   **doorwatch 现在已经把这条链路接上了** —— `ha/automations.yaml` 里那条
   「门磁电量 → doorwatch(IT 办公室)」每半小时把电量推到
   `doorwatch/it-office-door/battery`,服务端存下来,看板上会出现一个
   「电量 87%」的徽章,**低于 20% 会高亮**。
   > 电量读数**不会**刷新心跳,也不改门状态 —— 一台没电的设备要是还在报电量,
   > 看板必须继续显示「状态未知」。电量超过 7 天(`BATTERY_TIMEOUT_MS`)就不认了。
   想收到手机推送,再加一条低电量提醒(见 [`ha/README.md`](README.md) 的「电池」一节)。
2. **保留 ESPHome 方案**:干接点门磁 + ESP32 自己发心跳,
   传感器一断电,心跳立刻停,doorwatch 30 秒内就知道 —— 这条路线才真正测得到"传感器死没死"。
3. **接受现状**:蓝牙门磁的电池一般能撑一年多,真到没电那天,
   看板显示"关着"(最后一次的值),同事白跑一趟的概率不大。

> 如果你们更在意"绝不能显示过期状态",那就用 ESPHome 方案;
> 如果更在意"不动线、不烧固件",接受蓝牙方案的局限。

---

## 出问题对照表

| 现象 | 多半是 | 怎么查 |
|---|---|---|
| 看板一直是「状态未知」 | 模板实体没建起来 | HA 设置 → 工具 → 状态 搜 `doorwatch_it_office` |
| 看板一直是「状态未知」 | **保险丝不通过**(每分钟都推 offline) | 跑 `node tools/doctor.mjs --ha … --token …`,看「保险丝」那一行是「通过」还是「不通过」 |
| 看板一直是「状态未知」 | 实体名写错了 | `node tools/ha-probe.mjs` 看真实 entity_id |
| 看板一直是「状态未知」 | HA 版本太老,没有 `last_reported` | 设置 → 工具 → 模板,跑 `{{ states.binary_sensor.你的门磁.last_reported }}`,报错就是太老,升级 HA |
| 模板实体 = **`unavailable`** | 模板渲染抛了 `TemplateError` | 跑 `node tools/doctor.mjs --ha … --token …`,它会打出 HA 的报错原文和错误日志 |
| 模板永远输出 `UNKNOWN`,哪怕门开着 | 用了 `src in ['on','off']` | `src` 是**状态对象**,`State.__eq__` 比的是 entity_id → 恒为 False。要比文本必须写 `src.state in ['on','off']` |
| **保险丝永远不通过**(HA 里模板值是对的,看板却是未知) | 保险丝用了**模板实体**的 `last_reported` | 模板实体的 `last_reported` **不推进**(HA 只在渲染结果变化时才写回状态)。判死活只能用**原始门磁**的 `last_reported` |
| 看板不动,但 HA 里状态对 | MQTT 没通 | HA → 集成 → MQTT → 配置,看 broker 地址;服务端日志里看有没有「传感器接入」 |
| 服务端日志刷「收到未登记设备」 | deviceId 对不上 | 比对 `config/doors.json` 和 `automations.yaml` 里的主题后缀 |
| 状态反了(开门显示关) | 方向开关 | `templates.yaml` 里 `DOOR_ON_MEANS_OPEN` 改 `false` |
| 自动化每分钟报模板错误 | 用了 `states('x').last_updated` | `states('x')` 只返回文本,要时间戳得写 `states.x.last_reported` |
| 门开了看板要等半分钟才变 | 云端轮询 | 正常,xiaomi_miot 默认 60 秒一轮;想快点就 `xiaomi_miot: { interval_seconds: 30 }` |

---

## 做完之后

- 手机上加到主屏幕(PWA),出门前扫一眼。
- 想推送到微信/Telegram:`ha/automations.yaml` 末尾有注释掉的 `notify` 示例。
- 想加第二扇门:复制 `templates.yaml` 里的 sensor、`automations.yaml` 里的自动化、
  `config/doors.json` 里的记录 —— **三处的 deviceId 必须一致**。
