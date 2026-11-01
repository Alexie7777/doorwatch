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

  binary_sensor.aqara_it_office
      state=off  device_class=door  「门磁」
      last_changed  3 分钟前
      last_updated  3 分钟前   ← 状态/属性变化才动
      last_reported 8 秒前     ← 集成每轮写一次就动
```

加上 `--watch 120` 再等两分钟,它会告诉你这两个时间戳到底哪个在推进。
这一步很关键,原因见第 6 步。

### 手动找

HA → **开发者工具 → 状态**,搜 `door` / `magnet` / `contact` / `门`。
记下 `entity_id`(比如 `binary_sensor.aqara_it_office`)。

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
| Container / Core | 把 `ha/templates.yaml`、`ha/automations.yaml` 挂载到 `/config/` 下 |

### 3.2 在 `configuration.yaml` 顶层加两行

```yaml
template: !include templates.yaml
automation: !include automations.yaml
```

### 3.3 改 `templates.yaml` 里的实体名

把两处 `binary_sensor.aqara_it_office` 换成第 1 步查到的真名:

```yaml
{% set src = states.binary_sensor.aqara_it_office %}   # ← 改这里
```

方向不对的话,把 `DOOR_ON_MEANS_OPEN = true` 改成 `false`。

### 3.4 检查并重载

- **开发者工具 → YAML → 检查配置**,绿了再往下走。有红叉先别重载。
- 改了 `configuration.yaml` → 需要**重启 HA**。
- 只改了 `automations.yaml` → **自动化 → 右上角 ⋮ → 重新加载**就行,不用重启。

### 3.5 确认模板活了

**开发者工具 → 状态**,搜 `doorwatch_it_office`:

- `sensor.doorwatch_it_office_door_state` 应该是 `OPEN` / `CLOSED` / `UNKNOWN`
- `sensor.doorwatch_it_office_door_readable` 应该是 `on`(能读到)/ `off`(读不到)

两个都没有 → YAML 没装对,回 3.1 查。

---

## 第 4 步 确认 deviceId 对得上(2 分钟)

`config/doors.json` 里 IT 办公室这一条:

```json
{
  "id": "it-office",
  "name": "IT 办公室",
  "deviceId": "it-office-door"
}
```

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

## 第 6 步 验收(10 分钟,5 个用例)

前两个用例过了,基本就成了。第三个开始是"不许撒谎"的验收。

| # | 做什么 | 期望结果 | 预期耗时 |
|---|---|---|---|
| 1 | 在 HA 里看 `sensor.doorwatch_it_office_door_state` | `CLOSED`(门关着) | 立即 |
| 2 | 把门打开 | 看板变「开着」;HA 模板变 `OPEN` | ≤ 30 秒(云端轮询延迟) |
| 3 | 关上门,等一分钟 | 看板变「已关」 | ≤ 30 秒 |
| 4 | **把蓝牙网关断电**(或让门磁不可达) | 看板变「状态未知」,**不能继续显示"开着/关着"** | ≤ 3 分钟 |
| 5 | 网关恢复供电 | 看板自动恢复真实状态 | ≤ 1 分钟 |

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
   让 IT 定期看一眼,或者后续给 doorwatch 加一条"电量低"的提醒
   (服务端目前还没订阅电池主题,见 README「可以往下做的地方」)。
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
| 看板一直是「状态未知」 | 模板实体没建起来 | HA 开发者工具 → 状态 搜 `doorwatch_it_office` |
| 看板一直是「状态未知」 | 实体名写错了 | `node tools/ha-probe.mjs` 看真实 entity_id |
| 看板一直是「状态未知」 | HA 版本太老,没有 `last_reported` | 开发者工具 → 模板,跑 `{{ states.binary_sensor.你的门磁.last_reported }}`,报错就是太老,升级 HA |
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
