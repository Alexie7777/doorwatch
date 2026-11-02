# doorwatch × Home Assistant 接入指南

设备在路上的时候,这套东西可以先搭好。硬件到手后只需要做两件事:
**改一个实体名** 和 **把方向开关拨对**。

> **门磁已经接进 HA 了?**
> 不用读整份指南,直接看 **[`ha/CHECKLIST.md`](CHECKLIST.md)** ——
> 那是「从现在到看板动起来」的 6 步操作清单,30 分钟能走完,
> 含验收用例和故障对照表。
>
> 本文档是完整版:包含集成怎么装、蓝牙还是 Zigbee 怎么选、
> 以及每个坑的来龙去脉。清单里引用到的细节,都能在这里找到出处。

---

## 先搞清楚一件事:你的门磁是蓝牙还是 Zigbee

这一步决定后面所有事,别跳过。

| 型号 | 无线 | 需要什么网关 |
|---|---|---|
| **小米门窗感应器 2**(MCCGQ02HL) | **蓝牙 5.1 BLE** | 蓝牙网关 / 蓝牙 Mesh 网关 |
| 小米门窗感应器(一代) | Zigbee | 多模网关 / Aqara 网关 |
| Aqara 磁力门吸 E1 / H1 | Zigbee | 多模网关 / Aqara 网关 |

> 依据:小米官网 [Mi Door and Window Sensor 2 FAQ](https://www.mi.com/hk/support/faq/details/KA-05476/)
> 明确写着「小米门窗感应器 2 需搭配蓝牙网关,小米门窗感应器需搭配 Zigbee 网关」。

你说的是**小米门磁传感器 + 蓝牙网关**,那大概率是**小米门窗感应器 2(BLE 版)**。
装好后到米家 App 里确认一下设备型号,或看包装上的 `MCCGQ02HL`。

### ★ 这件事直接决定用哪个集成

| 集成 | 支持 BLE 门磁? | 支持 Zigbee 门磁? | 备注 |
|---|---|---|---|
| **Xiaomi Home**(小米官方) | **不支持** | 支持 | 官方文档写明「蓝牙、红外及虚拟设备暂不支持」 |
| **Xiaomi Miot Auto**(社区) | **支持** | 支持 | 明确写了 support Wi-Fi, **BLE**, ZigBee devices |

所以:

- **你的门磁是 BLE 版(大概率)→ 必须用 `xiaomi_miot`,官方集成会直接看不到这台设备。**
- 万一门磁是 Zigbee 版 → 两个都能用,优先官方 `Xiaomi Home`(小米自己维护,OAuth 登录,协议跟进更及时)。

> 依据:
> - 官方集成:小米开源的 [ha_xiaomi_home](https://github.com/XiaoMi/ha_xiaomi_home),README 与中文文档多处说明「蓝牙设备、红外设备和虚拟设备目前不在支持范围内」。
> - 社区集成:[hass-xiaomi-miot](https://github.com/al-one/hass-xiaomi-miot),项目描述即 "support Wi-Fi, BLE, ZigBee devices"。

**别两个都装。** 先装 `xiaomi_miot`,如果门磁根本没出现,再考虑换官方集成。

---

## 一、安装 Home Assistant

如果学校已经有 HA,跳过这步。

```bash
docker run -d --name homeassistant \
  --restart=unless-stopped \
  -v /opt/homeassistant:/config \
  --network host \
  homeassistant/home-assistant:stable
```

打开 `http://<服务器IP>:8123`,走引导流程建账号。

> 首次启动要 10–20 分钟,这是正常的。等不及的话用 HA OS 镜像(树莓派/NAS)。

---

## 二、装 `xiaomi_miot` 集成

集成本体仓库:[al-one/hass-xiaomi-miot](https://github.com/al-one/hass-xiaomi-miot)
(组件目录名 `xiaomi_miot`,HACS 里显示的名字是 **Xiaomi Miot Auto**)

### 方式 A:走 HACS

> ★ **在「添加集成」里搜不到 HACS 不是故障。**
> 下面两种情况都会这样,先看你的 HA 版本再对号入座。

#### A-0. HA 是 **2026.11 或更新** → 用内置的 Marketplace,什么都不用下载

从 HA 2026.11 起,**HACS 已经被官方内置为「Marketplace」集成**:

- 路径:**设置 → Marketplace**(在「设置」里,不在左侧边栏)
- 搜 "HACS" 搜不到是**正常的** —— 它现在叫 Marketplace
- HA 会**主动阻止**你再装旧的 HACS 自定义集成。升级后自动接管:
  之前用 HACS 装的东西都还在,自定义存储库和更新实体一并带过来,
  只是 `/hacs` 书签会跳到 Marketplace

> 依据:[HACS 官方文档 · HACS and the Marketplace](https://hacs.xyz/docs/marketplace/)

#### A-1. HA 是 **2026.10 或更早** → 先装 HACS 本体

HACS 是**自定义集成**,在把本体装进去之前,「添加集成」里必然搜不到。
这是先有鸡还是先有蛋的问题 —— 按你的安装类型挑一种:

| 安装类型 | 怎么装 |
|---|---|
| **HA OS / Supervised** | 添加第三方应用仓库 `https://github.com/hacs/addons` → 设置 → **应用** → 安装应用 → 选 **Get HACS** → 安装 → 启动该应用 → 按应用日志里的指示做 |
| **Container(Docker)** | `docker exec -it <跑 HA 的容器名> bash`<br>然后执行:`wget -O - https://get.hacs.xyz \| bash -` |
| **Core** | 切到运行 HA 的那个用户,执行:`wget -O - https://get.hacs.xyz \| bash -` |

装完 **重启 HA**,「添加集成」里就能搜到 `HACS` 了。

首次配置 HACS 要绑 GitHub 账号(设备码,8 位验证码)。
校园网访问 GitHub 不顺的话大概率卡在这 —— 那就**别装 HACS 了**,直接看下面的「方式 B」。

> 依据:[HACS 官方文档 · Downloading HACS](https://hacs.xyz/docs/use/download/download/)

#### A-2. HACS 装好之后,再装 Xiaomi Miot Auto

1. HACS → 集成 → 右下角 **➕** → 浏览并下载存储库 → 搜 `Xiaomi Miot Auto` → 下载
2. **重启 HA**(HACS 页面会显示红色感叹号提示要重启,重启后消失)
3. 设置 → 设备与服务 → 添加集成 → 搜 `Xiaomi Miot` → 添加

### 方式 B:直接装(**推荐 —— 完全绕开 HACS**)

> ★ **只需要这一个集成的话,装 HACS 是纯多余的负担:**
> HACS 要绑 GitHub 账号、要过 GitHub 网络、以后还得管更新。
> `xiaomi_miot` 自带安装脚本,一条命令就到位,装完直接能用。

**HA OS / Supervised**:设置 → 加载项 → 加载项商店 → 装 **Terminal & SSH**,
打开后执行:

```shell
wget -O - https://raw.githubusercontent.com/al-one/hass-xiaomi-miot/master/install.sh | ARCHIVE_TAG=latest bash -
```

下载慢就换代理:

```shell
wget -O - https://ghproxy.com/raw.githubusercontent.com/al-one/hass-xiaomi-miot/master/install.sh | HUB_DOMAIN=ghproxy.com/github.com ARCHIVE_TAG=latest bash -
```

**Container(Docker)**:先进容器,再跑同一条命令

```shell
docker exec -it <跑 HA 的容器名> bash
wget -O - https://raw.githubusercontent.com/al-one/hass-xiaomi-miot/master/install.sh | ARCHIVE_TAG=latest bash -
```

**不想用 SSH 的话,用 `shell_command` 服务**(见方式 C):

> ★ 装完**不需要再装 HACS**,直接往下看「添加集成」就行。
> 集成名在 HA 里叫 **`Xiaomi Miot`**,HACS 里才显示为 `Xiaomi Miot Auto`。

### 添加集成

设置 → 设备与服务 → 添加集成 → 搜 `Xiaomi Miot`(不是 `Xiaomi Miot Auto`)→

- **添加方式**:选 **账号集成**(用小米账号)
- **连接模式**:选 **云端模式**
  - BLE 门磁只能走云端 —— 本地直连只对 WiFi/网线设备有效,局域网控制也管不到 BLE/ZigBee
  - 选「本地模式」的话 BLE 门磁会直接变成 unavailable
- **区域**:中国大陆账号选 `cn`。小米云按六个区域分区,数据互相隔离,选错导入不到设备

**装完检查**:设置 → 设备与服务 → 已配置 → Xiaomi Miot,应该能看到你的门磁。
看不到就是设备没被导入,回日志看原因(设置 → 系统 → 日志,搜 `miot`)。

> ★ **门磁这类设备是靠轮询读的,不是实时推送。**
> 作者在 [issue #100 的说明](https://github.com/al-one/hass-xiaomi-miot/issues/100#issuecomment-909031222)里写得很清楚:
> 人体、门磁、无线开关这类设备的状态本质是「事件」,
> 集成默认 15 秒轮询一次,**不适合拿去做实时触发的自动化**,
> 只适合当「几分钟内没动静就关灯」这类条件。
>
> 对 doorwatch 来说这完全够用 —— 你的需求本来就是「出门前扫一眼」,
> 15–30 秒的延迟不痛不痒。想要真正实时就得上多模网关 + XiaomiGateway3,
> 但那是 Zigbee 路线,小米蓝牙网关走不了。

### 方式 C:`shell_command` 服务(HA OS 上最省事,不用 SSH)

`configuration.yaml` 里加:

```yaml
shell_command:
  update_xiaomi_miot: |-
    wget -O - https://get.hacs.vip | DOMAIN=xiaomi_miot bash -
```

重启 HA → 设置 → 工具 → 动作 → 调用 `shell_command.update_xiaomi_miot`
→ **再重启一次 HA**。

### 方式 D:手动拷贝(完全离线也行)

```shell
cd /opt/homeassistant/custom_components
git clone https://github.com/al-one/hass-xiaomi-miot.git xiaomi_miot
```

或者下载 [release 的 zip](https://github.com/al-one/hass-xiaomi-miot/releases),
解压后把 `custom_components/xiaomi_miot` 整个文件夹拷到 HA 配置目录的
`custom_components/` 下。

**重启 HA。** 手动装的话建议重启两次。

---

## 三、找到门磁的实体名

装好集成后,门磁会出现几个 `binary_sensor`。**不要用 `motion` 那个**(那是靠近检测,
不是开合)。要的是开合那个。

最快的方法:设置 → 工具 → 状态,搜 `binary_sensor`,然后在米家 App 里开合门,
看哪个实体的值跟着变。

### 用探针脚本一次问清楚(推荐)

```bash
node tools/ha-probe.mjs --host http://homeassistant.local:8123 --token <TOKEN>
```

token 在 HA 里拿:左下角头像 → 安全 → 长期访问令牌 → 创建令牌。
它会列出所有门磁候选实体、当前状态,以及三个时间戳分别多久没动。

加 `--watch 120` 还能观察两分钟,直接看出**哪个时间戳在推进**
(这决定了新鲜度判据该怎么写,见第四节)。

小米门窗感应器 2 在 `xiaomi_miot` 里通常是:

```
binary_sensor.isa_dw2hl_b95b_magnet_sensor ← 磁铁状态,device_class=door ✅ 用这个
binary_sensor.isa_dw2hl_b95b_contact_state ← MIoT 原始属性,极性相反,别用
binary_sensor.isa_dw2hl_b95b_motion        ← 靠近检测,别用这个
```

> 实体名带设备名后缀,取决于你在米家 App 里给设备起的名字。
> 本仓库的 `templates.yaml` **已经填成上面第一个**,名字对得上就不用改;
> 不一样就全文件替换这一处(文件里有 2 处生效)。

### 实体名不重要,重要的是**方向**

MIoT 规范里门磁的属性叫 `contact-state`(接触状态),布尔值。问题是它的语义:

- 磁铁**靠近** = 门**关着** = `contact-state` 为 **true**
- 磁铁**离开** = 门**开着** = `contact-state` 为 **false**

而 HA 的 `binary_sensor` 习惯是「on = 打开」。两边可能正好相反。
所以装完第一件事就是开一次门验证方向(见后面「到货后 10 分钟验收」)。

---

## 四、装配置文件

把本目录三个文件接进 HA:

```yaml
# HA 的 configuration.yaml
template: !include templates.yaml
automation: !include automations.yaml
```

把 `ha/` 下的 `templates.yaml`、`automations.yaml` 复制到 HA 的 config 目录。

> 📌 **HA 2026 改了位置,侧边栏里找不到「开发者工具」不是你的错觉**:
>
> - **2026.2** —— 开发者工具从侧边栏挪进了「设置」
> - **2026.8** —— 正式改名为 **「工具」/ Tools**,地址 `/config/tools`
>
> 所以 2026.2 之后的版本侧边栏里**已经没有**这一项了。
> 直接开 `http://<你的HA>:8123/config/tools` 就能进;
> 老地址 `/developer-tools` 会自动 302 跳到新地址。
>
> 里面对应的页面(老名字 → 新地址):
>
> | 老标签页 | 新地址 |
> |---|---|
> | 状态 | `/config/tools/state` |
> | 模板 | `/config/tools/template` |
> | 动作 | `/config/tools/action` |
> | 事件 | `/config/tools/event` |
> | **YAML(检查配置 / 重载)** | **`/config/tools/yaml_configuration`** |
> | 调试 / 调试控制台 | `/config/tools/debug`、`/config/tools/debug_console` |
> | 统计 / 动作历史 | `/config/tools/statistics`、`/config/tools/action_history` |
>
> ⚠️ 这一块是**仅管理员可见**(`adminOnly`)。侧边栏里连「工具」都没有的话,
> 说明账号不是 admin 角色 → 设置 → 人员 → 把账号角色改成「管理员」。

#### ⚠️ 两个 YAML 都必须是「裸列表」

`!include` 是把文件内容**直接塞到 `template:` / `automation:` 这个键的位置上**。
所以文件里如果还有一层 `template:`,HA 会报:

```
Invalid config for 'template' at templates.yaml, line 105:
'template' is an invalid option for 'template', check: template
```

本仓库的 `templates.yaml` 和 `automations.yaml` **都已经是裸列表**,直接用,
别自己再套一层。想手动粘进 `configuration.yaml` 的话,补上键名并整体缩进两格:

```yaml
template:
  - sensor:
      - name: "Doorwatch IT Office Door State"
        # ...整段往下缩进两格
```

#### HA 跑在 Docker 里?挂载要写完整的文件路径

```yaml
  homeassistant:
    image: ghcr.io/home-assistant/home-assistant:stable
    volumes:
      - ./config:/config                              # HA 自己的配置目录
      - ../ha/templates.yaml:/config/templates.yaml:ro    # ← 文件路径,不是目录
      - ../ha/automations.yaml:/config/automations.yaml:ro
```

⚠️ **写成 `- ../ha/templates.yaml:/config` 会报这个错**:

```
not a directory: Are you trying to mount a directory onto a file (or vice-versa)?
```

因为 `/config` 在镜像里本来就是目录,把文件挂到目录上,类型对不上。

⚠️ **别挂到 doorwatch 容器上** —— `ha/*.yaml` 是给 HA 用的,
doorwatch 服务端一行都不读(它只读 `config/doors.json`)。
doorwatch 容器只该挂 `doorwatch-data:/data`。

然后:

1. 改 `templates.yaml` 里的实体名 → 你的实际实体
2. 改 `automations.yaml` 里的主题后缀 → 你的 deviceId(见下一节)
3. **设置 → 工具 → 配置(YAML)→ 检查配置**,绿勾再重载

> ★ **只需要改 `templates.yaml` 一个文件里的实体名**(本仓库已填好,一般不用动)。
> `automations.yaml` 里出现的 `sensor.doorwatch_it_office_door_state` /
> `binary_sensor.doorwatch_it_office_door_readable` 是本套模板自己定义的实体,
> 名字固定,不用动。要改的只有 `templates.yaml` 里那 2 处
> `binary_sensor.isa_dw2hl_b95b_magnet_sensor`(两个模板各一处,全局替换一下就行)。
>
> ★ `automations.yaml` 里的主题后缀 `it-office-door` 是 **deviceId**,
> 和实体名是两回事,别搞混(见第五节)。

> ★★ **可读性模板必须放在 `binary_sensor:` 下面,不能挪到 `sensor:`**。
> `sensor` 平台会把 `{{ true }}` / `{{ false }}` 渲染成字符串 `"True"` / `"False"`,
> 而自动化里的保险丝判的是 `r.state == 'on'` —— 对 sensor 来说**永远不成立**,
> 结果就是每分钟都走 else 分支推 `offline`,看板一直显示「状态未知」。
> `binary_sensor` 平台会用 `result_as_boolean()` 把结果转成 `on` / `off`,保险丝才判得对。
> (HA 源码:`components/template/binary_sensor.py` 的 `_update_state`)
>
> 实体 id 也跟着变:`binary_sensor.doorwatch_it_office_door_readable`。

### ★ 为什么模板层要用「上报时间」判断传感器死活

这是本方案最容易踩、也最要命的坑。

`xiaomi_miot` 在设备无响应时,**不会**把实体置为 `unavailable`,
而是无限期保留最后一次读到的状态 —— 社区 issue [#2699](https://github.com/al-one/hass-xiaomi-miot/issues/2699)
确认了这一点,集成作者回复说「主要与轮询机制有关,异常没有正确映射到实体的 available 属性」。

后果很严重:如果只看 `states('binary_sensor.x')` 是不是 `'on'`/`'off'`,
那么**门磁电池耗尽之后,看板会一直显示"门开着"** ——
传感器明明已经死了,看板却在撒谎。这正是 doorwatch 要拼命避免的事。

所以 `templates.yaml` 里判断传感器是否还活着,用的是**它最后一次上报的时间**。

#### ★★ 这里必须用 `last_reported`,不能用 `last_updated`

Home Assistant 官方对三个时间戳的定义:

| 时间戳 | 含义 | 什么时候更新 |
|---|---|---|
| `last_changed` | 状态**值**变了 | 只在 on↔off 这种真变化时 |
| `last_updated` | 状态**或属性**变了 | 门开着不动就不动 |
| `last_reported` | 实体**上报**了一次 | 集成每写一次状态就往前推 |

关键在 HA 源码(`homeassistant/core.py` 的 `async_set_internal`):
状态值和属性都没变时,走的是「提前返回」分支 —— **只更新 `last_reported`,
`last_updated` 根本不会动**。

而 `xiaomi_miot` 每次轮询都会把状态写一遍(`force_update` 默认 false),
所以门一直关着的时候,`last_updated` 会一直冻在最后一次开门的那一刻。

拿 `last_updated` 当判据,会闹出这个荒唐局面:

> 门关着不动 → `last_updated` 冻住 → 超过 180 秒 → 报 `UNKNOWN`
> → 看板一直显示「状态未知」,可传感器其实活得好好的。

这不是撒谎,但比撒谎更招人烦 —— 没人会用一块永远显示未知的看板。

`last_reported` 才是对的:集成每轮写一次状态它就推一次;
传感器真死了,轮询失败不写状态,它就不动 —— 正好是我们要的。

模板里是这么写的(自动兼容没有 `last_reported` 的老 HA):

```yaml
{% set seen = src.last_reported | default(src.last_updated, true) %}
{% set alive = seen is defined and seen is not none
              and (as_timestamp(now()) - as_timestamp(seen)) < STALE_SECONDS %}
```

#### ★★ HA 模板语法坑:`states('x')` 只返回文本

```yaml
states('binary_sensor.x')                  # → "on"   ← 只有状态文本
states('binary_sensor.x').last_updated     # → 报错!文本没有这个属性
states.binary_sensor.x.last_reported       # ✅ 时间戳要这么写
```

本项目之前就踩过这个坑:自动化里写成了 `states('...').last_updated`,
每分钟抛一次模板错误,整条「体检」自动化直接哑火。

#### 超时怎么算

超过 `STALE_SECONDS`(默认 180 秒)没上报 = 传感器失联 = 输出 `UNKNOWN`
= 不发光跳 = doorwatch 降级成未知。

配套地,`automations.yaml` 里有一条「传感器失联 → 立刻发 `status: offline`」,
让看板**马上**降级,而不是干等心跳超时(180 秒)。

> 老版本 HA 没有 `last_reported`(2025 年年中才加的),模板会自动回退到
> `last_updated` —— 这时会出现上面说的「一直未知」。升级 HA 即可。
> 在「设置 → 工具 → 模板」里跑 `{{ states.binary_sensor.你的门磁.last_reported }}`
> 报错,就说明你的 HA 需要升级。

> 官方 `Xiaomi Home` 集成没有这个问题 —— 它订阅的是小米云 MQTT Broker,
> 设备状态变化由 Broker 推送,不做轮询。但它不支持蓝牙设备,所以 BLE 门磁用不了。
> 这就是为什么社区这条路必须自己补上这层判断。

### ★★ 还要再补一刀:模板不会自己按时重算

上面那个判据要成立,前提是模板**在那一刻真的被重新算了一遍**。

而 HA 的模板实体默认只在「它引用的实体状态变了」时才重算。
问题来了:传感器死了以后,状态值是不变的(`on` 还是 `on`),于是模板也不会重算 ——
新鲜度判据会一直卡在最后一次的结果上,
模板里明明传感器早就失联了,写出来的却还是 `OPEN`。

所以 `automations.yaml` 里有一条「每分钟体检」,第一件事就是:

```yaml
- action: homeassistant.update_entity
  target:
    entity_id:
      - sensor.doorwatch_it_office_door_state
      - binary_sensor.doorwatch_it_office_door_readable
```

每分钟强行重算一次,新鲜度判据才拿得到"此刻"的时间。
(HA 源码:`update_entity` → `async_update_ha_state(force_refresh=True)`
→ `async_device_update()` → `TemplateEntity.async_update()` → 重新渲染模板。)

这条自动化还带了三道保险,必须**同时成立**才推状态+心跳,否则推 `offline`:

| # | 条件 | 挡的是什么 |
|---|---|---|
| ① | 原始门磁的 `last_reported` 在 180 秒内 | 传感器真的还在上报 |
| ② | `readable` 这个实体的**状态**是 `on` | 模板算出来的「读不到」 |
| ③ | 状态模板给出的是 `OPEN`/`CLOSED`(不是 `UNKNOWN`) | 模板本身失灵 |

#### ★★★ 硬规则三:保险丝绝对不能拿**模板实体**的时间戳判死活

这一条踩过一次线上事故,记清楚:

**模板实体的 `last_reported` 是不推进的。**

HA 源码(`homeassistant/helpers/event.py`,
`TrackTemplateResultInfo._render_template_if_ready`):

```python
if result == last_result and template in self._last_result:
    return True          # ← 渲染结果没变,连 update 都不产生
```

结果没变 → 不产生 update → 回调不跑 → `async_write_ha_state()` 不跑
→ 状态压根没被写进 state machine → **`last_reported` 永远不动**。

于是模板实体的 `last_reported` 冻结在「值最后一次变化」的那一刻。
拿它算新鲜度,必然在两分钟后变成「过期」→ 保险丝永远不通过
→ 每分钟都推 `offline` → **看板永远显示「状态未知」**,
而门磁明明好好的、每分钟都在上报。

**原始门磁就不一样**:`xiaomi_miot` 每轮轮询都会写一次状态,
值没变时 HA 走 `async_set_internal` 的「提前返回」分支 ——
**只更新 `last_reported`**。所以它的 `last_reported` 是真在推进的,
那才是可信的存活信号。

> ★★ 顺带记住一个容易搞混的地方:
>    **模板实体的「值」是准的,只是它的时间戳不准。**
>    值每分钟被 `update_entity` 重算一次,只是「没变就不写回去」。
>    所以 ② ③ 可以放心用**值**来判断,**只有时间戳不能用**。

> 一句话:**三道防线,任何一道生效,看板都不会显示过期的开/关。**
> ① 模板输出 `UNKNOWN` → 推给 doorwatch → 立刻打回未知
> ② 「每分钟体检」推 `status: offline` → 立刻打回未知
> ③ doorwatch 自己的心跳超时(180 秒)→ 兜底

### ★★ 模板层的另外两条硬规则(各踩过一次,写下来免得再踩)

#### 规则一:`as_timestamp()` 必须放在 `{% if %}` 的 **body** 里

`as_timestamp()` 只认 `datetime`。喂给它 `Undefined` 或字符串,内部会走
`parse_datetime(str(value))` → 解析失败 → `raise ValueError("not a valid date/time.")`
→ `TemplateError` → HA 把实体置成 **`unavailable`**。

而 Jinja 的 `and` 是**短路**的 —— 于是同一个文件里的两个模板会闹出这种迷惑现象:

```jinja
{# A:as_timestamp 在独立的 {% set %} 里 → 无条件求值 → 炸 #}
{% set alive = seen is defined and seen is not none
              and (as_timestamp(now()) - as_timestamp(seen)) < 180 %}
{% if src in ['on', 'off'] and alive %} ... {% endif %}

{# B:同一个表达式在 and 链末端 → 前面为 False 就短路 → 压根不求值 → 活 #}
{% if src in ['on', 'off'] and seen is defined and seen is not none
      and (as_timestamp(now()) - as_timestamp(seen)) < 180 %} ... {% endif %}
```

线上真实事故就是 A 和 B 同时存在:一个实体 `unavailable`,
另一个好好地渲染出 `False`。两者用的是**同一个源实体、同一个判据**,
看着毫无关系 —— 靠读代码根本看不出来。

唯一可靠的做法是让守卫先跑:

```jinja
{% set fresh = false %}
{% if src is not none and seen is defined and seen is not none
       and seen.year is defined %}          {# seen 必须真的是 datetime #}
  {% set fresh = (as_timestamp(now()) - as_timestamp(seen)) < STALE_SECONDS %}
{% endif %}
```

`seen.year is defined` 是在问「它有没有年份」:`datetime` 有,字符串和 `Undefined` 都没有
→ 非 datetime 一律挡在外面,模板老老实实输出 `UNKNOWN`,而不是把实体搞成 `unavailable`。

#### 规则二:状态对象不能直接跟字符串比

`states.binary_sensor.x` 拿到的是**状态对象**,不是状态文本。
HA 的 `State.__eq__` 比的是 `entity_id`(而且只跟另一个 `State` 比):

```python
def __eq__(self, other: object) -> bool:
    return isinstance(other, State) and self.entity_id == other.entity_id
```

所以 `src in ['on', 'off']` 和 `src == 'on'` **恒为 False** ——
哪怕门开着、传感器刚上报过,模板也只会输出 `UNKNOWN`。
要比文本必须写 `src.state`。

> 这两条都有离线仿真守着:`npm run check:ha-templates` 跑 7 个场景,
> 还会把旧模板的事故现场复现一遍(一个 `unavailable`、一个 `False` 的不对称),
> 确认新版模板已经修好。

#### 想在装配置之前就确认模板没问题?

用 doctor 的**现场渲染**:它把本仓库的模板直接 POST 给 HA 的 `/api/template`,
当场看会渲染成什么,渲染失败还会把 HA 的报错原文带回来:

```bash
node tools/doctor.mjs --doorwatch https://<服务器>:8443 --insecure \
  --ha http://<HA>:8123 --token <TOKEN>
```

### 轮询间隔要配

`xiaomi_miot` 默认 **60 秒**轮询一次(`interval_seconds` 可改)。
默认 60 秒的话,`STALE_SECONDS` 用 180 只剩 3 次轮询的余量,偏紧,建议 240。

```yaml
# configuration.yaml
xiaomi_miot:
  interval_seconds: 30
```

然后把 `templates.yaml` 里的 `STALE_SECONDS` 保持在 180(约 6 次轮询的余量)。
调小轮询间隔会加快状态更新,但也会增加小米云的压力 —— **不建议低于 15 秒**。

改完配置不用重启 HA:设置 → 工具 → 配置(YAML)→ 配置重载 → 搜 `Xiaomi Miot` → 重载。

---

## 五、让 HA 和 doorwatch 对上

两边必须用同一个 broker。二选一:

### 方案 A:HA 没有 MQTT broker(推荐,doorwatch 零改动)

doorwatch 自带 MQTT broker(内嵌 aedes)。在 HA 里:

设置 → 设备与服务 → 添加集成 → **MQTT** → 填:

| 字段 | 值 |
|---|---|
| Broker | doorwatch 服务器的 IP |
| Port | `1883` |
| Username / Password | 留空 |

### 方案 B:HA 已经装了 Mosquitto

doorwatch 侧改环境变量,**不用改代码**:

```yaml
MQTT_HOST: 10.0.0.5
MQTT_PORT_EXTERNAL: 1883
MQTT_USERNAME: doorwatch
MQTT_PASSWORD: 你的密码
```

### 主题里的 deviceId 必须一致

这是最容易翻车的地方。三个地方要一模一样:

| 位置 | 值 |
|---|---|
| `ha/automations.yaml` 主题末段 | `it-office-door` |
| `doorwatch/config/doors.json` 的 `deviceId` | `it-office-door` |
| HA 集成里看到的实体名 | 无关(自动化里映射过了) |

对不上的话,doorwatch 服务端日志会打:

```
[mqtt] 收到未登记设备 "xxx" 的消息(state),已忽略。
```

**看到这行就是 ID 对不上**,不是玄学问题。

---

## 六、到货后 10 分钟验收

设备装上、HA 里能看到了,按这个顺序验:

### 1. 方向对不对(最容易错的一步)

**别假设 `on` 就一定是"门开着"。** 磁力门吸的语义在不同集成里可能反过来
(有的把"磁铁吸附"当 on,而磁铁吸附 = 门关着)。

验法:

1. 打开门
2. 看 HA 里 `sensor.doorwatch_it_office_door_state` 的值
3. 如果门开着时它显示 `CLOSED` → **方向反了**

反了就改 `templates.yaml`:

```yaml
{% set DOOR_ON_MEANS_OPEN = true %}    ← 改成 false
```

保存即生效,不用重启 HA。

### 2. 看板和 HA 一致吗

打开看板,看状态和 HA 里那个 sensor 是否一致。

### 3. 断电测试(最重要的一步)

**把网关断电,看板必须在一两分钟内变成「状态未知」。**

具体表现:

1. 断电后,HA 里 `binary_sensor.doorwatch_it_office_door_readable` 应该变成 `off`
   (或者 `sensor.doorwatch_it_office_door_state` 变成 `UNKNOWN`)
2. 看板随即显示「状态未知」,并标注「传感器离线」
3. 千万别出现这种情况:看板还稳稳地显示「门开着」——
   那说明心跳链路没通,或者 `templates.yaml` 里的实体名填错了

怎么排查:

- HA 里看自动化的运行记录:设置 → 自动化 → 找到「每分钟体检」→ 看有没有执行
- doorwatch 服务端日志应该出现 `[mqtt] it-office-door 上报 UNKNOWN -> 状态打回"未知"`
  或者 `it-office-door 离线`
- 两边都没有 → 先确认 HA 能连上 broker(第五节)

> 这一步不能省。整套系统的价值就在这:传感器死了的时候看板**必须说不知道**,
> 而不是拿最后一次的状态骗人 —— 否则同事会在最需要的时候白跑一趟。

### 3.5 再测一次:门磁自己没电了(蓝牙方案的固有局限)

上面测的是「网关断电」。还有一种情况得单独测清楚,
否则日后会误以为系统坏了:

**把门磁的电池取掉,但网关和 WiFi 都正常。**

| 测到的结果 | 含义 |
|---|---|
| 看板变成「状态未知」 | 更好,说明连这个也能测出来 |
| 看板还显示「门开着/关着」 | **这是蓝牙 + 云端路线的固有局限**,不是 doorwatch 的 bug |

原因是:门磁不主动上报,米家云会把**最后一次的值**继续返回给 HA,
HA 这边一切正常(实体状态不变、`last_reported` 一直在推进),
所以看板看不出门磁已经死了。

三个可选对策:

1. **看电量**:MIoT 门磁带 `battery-level`,HA 实体属性里就有,
   做个低电量提醒或者定期人工看一眼。
   (doorwatch 服务端目前还没订阅电池主题,见 README「可以往下做的地方」)
2. **保留 ESPHome 方案**:干接点门磁 + ESP32 自己发心跳,
   传感器一断电心跳立刻停,doorwatch 30 秒内就知道 ——
   这条路线才真正测得到「传感器死没死」。
3. **接受现状**:蓝牙门磁电池一般能撑一年多,真没电那天看板显示最后一次的值,
   同事白跑一趟的概率不大。

> **要「绝不能显示过期状态」就选 ESPHome;要「不动线、不烧固件」就得接受这个局限。**
> 想清楚再定,别等到上线才发现。

### 4. 恢复测试

把网关通电,等一个轮询周期(30 秒内),
看板应该自己回到「门开着/门关着」,**不需要手动干预**。

这条同样重要:降级容易,恢复难。
如果一直卡在「状态未知」,看 `automations.yaml` 里
「每分钟体检」那条有没有在跑 —— 它负责把状态重新推回来。

> 完整的验收用例表见 [`ha/CHECKLIST.md`](CHECKLIST.md) 第 6 步。

---

## 七、已知的坑

### ★ `xiaomi_miot` 的 token 会过期(约 7 天)

社区有大量报告:用着用着全部设备失联,日志里是 `SERVICETOKEN_EXPIRED`。
原因大致是集成模拟的设备指纹比较旧,触发了小米云的风控,token 被缩短到 7 天。

**表现**:门磁在 HA 里集体变 `unavailable` → 我们的模板输出 `UNKNOWN` →
不发光心跳 → doorwatch 降级成「状态未知」。**行为是安全的,但看板会失灵。**

**解法(选一个)**:

- 每周日凌晨 4 点重载一次集成:

  ```yaml
  - id: xiaomi_miot_reload
    alias: "每周重载小米集成"
    mode: single
    triggers:
      - trigger: time
        at: "04:00:00"
    conditions:
      - condition: time
        weekday: [sun]
    actions:
      - action: homeassistant.reload_config_entry
        target:
          entity_id: integration.xiaomi_miot
  ```

- 或者手动:设置 → 设备与服务 → Xiaomi Miot Auto → ⋮ → 重新加载。

### ★ HA 的 MQTT 集成报 "MQTT protocol migration failed"

#### 它到底是什么

HA 源码(`homeassistant/components/mqtt/__init__.py` 的 `async_setup_entry`)写着:

```python
if (protocol := entry.data.get(CONF_PROTOCOL, PROTOCOL_311)) != PROTOCOL_5:
    # Automatically migrate the broker protocol to v5 if possible
    # Can be removed with HA Core 2027.1
    new_entry_data = entry.data.copy()
    new_entry_data[CONF_PROTOCOL] = PROTOCOL_5
    # 试连一次 v5
    if await try_connection(new_entry_data):
        → 静默把配置条目升级成 v5,顺手删掉这个 repair
    else:
        → 建一个 repair:protocol_5_migration
          breaks_in_ha_version="2027.1.0"
```

翻译成人话:

| 什么时候 | 会发生什么 |
|---|---|
| **每次加载 MQTT 集成**(HA 启动 / 重载) | 如果当前不是 v5,HA 就**试连一次 MQTT 5** |
| 试连成功 | HA **静默升级**成 v5,repair 消失,以后一直用 v5 |
| 试连失败(aedes 就是这样) | 弹一个红色 repair,HA **继续用 3.1.1 正常跑** |

**为什么 aedes 试连会失败**:aedes 1.2.0 的 README 里就写着 `MQTT 5.0 (not support yet)`。
MQTT 5 的 CONNECT 包带 properties,aedes 解析不了,连接直接被拒。

#### 现在有没有影响?

**没有。** HA 继续用 3.1.1 连着,收发都正常 —— 你刚验证过的整条链路走的就是 3.1.1。
这个 repair 只是提醒你"该换了",不影响任何功能。

#### 2027.1.0 那一天会发生什么

`breaks_in_ha_version="2027.1.0"` 的含义是:**从 HA 2027.1.0 起,还在 3.1.1 的
MQTT 配置条目会被 breaking change 机制直接拒绝加载**。
不是"降级",不是"多一句警告" —— 是 **MQTT 集成整个不工作**:

- 自动化里的 `mqtt.publish` 全部报错 → doorwatch 收不到任何消息
- 看板显示「状态未知」,而且这次是真的读不到

同时源码里那句 `Can be removed with HA Core 2027.1` 说明:到 2027.1,
连"帮你试连一次自动升级"这套逻辑都会被删掉。

> ⏰ **现在是 2026 年 11 月,离 HA 2027.1 只剩两个月。**
> 建议现在就换,别拖到年底 —— 升级 HA 通常还要挑时间,提前把 broker 换掉最省事。

#### 怎么换:换 Mosquitto(推荐,一次到位)

Mosquitto 2 原生支持 MQTT 5,还更省内存。**doorwatch 服务端零改动**就支持外部 broker
(设 `MQTT_HOST` 就行),所以只要改 compose:

```yaml
services:
  mosquitto:
    image: eclipse-mosquitto:2
    restart: unless-stopped
    volumes:
      - ./mosquitto.conf:/mosquitto/config/mosquitto.conf:ro
      - mqtt-data:/mosquitto/data
  doorwatch:
    environment:
      MQTT_HOST: mosquitto          # ← 指到 mosquitto 这个服务
      MQTT_PORT_EXTERNAL: 1883

volumes:
  mqtt-data:
```

`deploy/mosquitto.conf`:

```
listener 1883
allow_anonymous true
persistence true
persistence_location /mosquitto/data/
```

⚠️ `allow_anonymous true` 只适合**内网**。要给校外访问的话改成账号密码,
doorwatch 侧填 `MQTT_USERNAME` / `MQTT_PASSWORD`,HA 侧填同样的账号。

> 换完之后 HA 的 MQTT 集成要**重新配一次** broker 地址,协议版本选 5。
> 下次 HA 启动时它自己会试连 v5 —— 成功就把配置条目升级成 v5,那个 repair 自动消失。

#### ❌ 一条被源码证伪的说法:「手动锁死 3.1.1 就能消掉 repair」

本节以前写的是"去 HA 的 MQTT 配置里把协议版本选 3.1.1,repair 就没了"。
**那是错的**,判断条件摆在那儿:

```python
if (protocol := entry.data.get(CONF_PROTOCOL, PROTOCOL_311)) != PROTOCOL_5:
```

它问的是「**现在是不是 v5**」,不是「**用户有没有显式选过 3.1.1**」。
你手动选 3.1.1 → `protocol` 依然 `!= PROTOCOL_5` → HA 下次启动**照样去试 v5**
→ 照样失败 → **照样弹 repair**。

所以:**这个 repair 没有配置层面的消除办法,只有把 broker 换成支持 MQTT 5 的才行。**

### BLE 门磁只能走云,延迟 15–30 秒

BLE 设备没有本地直连,只能让网关中转到米家云再读回来。

延迟主要来自轮询间隔。集成全局默认 30 秒,但**门磁这类「事件型」设备默认 15 秒**
(作者在 [issue #100](https://github.com/al-one/hass-xiaomi-miot/issues/100#issuecomment-909031222) 里说的)。
全局可以在 `configuration.yaml` 里调:

```yaml
xiaomi_miot:
  interval_seconds: 15
```

也可以只给某个设备调(账号集成时每个设备要单独设):

```yaml
xiaomi_miot:
  device_customizes:
    lumi.sensor_magnet.aq2:
      interval_seconds: 10
```

**调太小没意义。** 作者原话:「对于无法获取最后触发事件的设备,
即使修改轮询时间到 1 秒,也可能无法获取正确的状态」——
所以别指望靠调小间隔把延迟压到实时。15–30 秒对 doorwatch 够用了。

> 想要真正实时(亚秒级)只有一条路:**多模网关 + XiaomiGateway3 集成**,本地直连不经过云。
> 但那是 Zigbee 路线 —— 小米蓝牙网关刷不了第三方固件,这条路对 BLE 门磁是死的。

### 蓝牙网关要给固定 IP

网关 IP 飘了会导致集成断连,得手动重载才能恢复。路由器里给网关绑定静态 IP。

### 门磁和网关的距离

小米官方建议:室内复杂环境**20 米以内**,有墙的话要缩短,**5 米以内最佳**。

### 电池

CR2032,官方标称可用 1–2 年。别等它彻底没电。

**doorwatch 现在能显示电量了** —— `ha/automations.yaml` 里那条「门磁电量 →
doorwatch(IT 办公室)」每半小时把电量推到 `doorwatch/it-office-door/battery`,
服务端存下来,看板上出现一个「电量 87%」的徽章;**低于 20% 会高亮**。

> 为什么蓝牙方案非要这一条:
> ESP32 方案里传感器一断电心跳立刻停,doorwatch 30 秒内就知道它死了。
> 蓝牙方案没有这个信号 —— 门磁没电、网关和云都正常时,云端会**继续返回
> 最后一次的值**,看板测不出传感器已经死了。**电量是唯一的预警。**

还想收到手机推送的话,再加一条低电量提醒:

```yaml
- id: doorwatch_battery_low
  alias: "门磁低电量提醒"
  mode: single
  triggers:
    - trigger: time_pattern
      minutes: "/30"
  actions:
    - variables:
        battery_payload: >
          {% set a = state_attr('binary_sensor.isa_dw2hl_b95b_magnet_sensor', 'battery_level') %}
          {% set b = states('sensor.isa_dw2hl_b95b_battery_level') %}
          {% set c = states('sensor.isa_dw2hl_b95b_battery') %}
          {% set raw = a if a is not none else (b if b not in ['unknown', 'unavailable'] else c) %}
          {% set num = raw | float(none) %}
          {{ (num | int) if num is not none and num >= 0 and num <= 100 else 'none' }}
    - if:
        - condition: template
          value_template: "{{ (battery_payload | string) | int(100) < 20 }}"
      then:
        - action: notify.mobile_app_xxx
          data:
            title: "门磁电量不足"
            message: "IT 办公室门磁只剩 {{ battery_payload }}%,记得换电池"
```

> ★ **电量在哪有两种可能,两种都要认**:
> - 主实体上的**属性** `battery_level`(`xiaomi_miot` 默认会把它挂到该设备的所有实体上)
> - 独立的**实体** `sensor.isa_dw2hl_b95b_battery_level`(有些版本/型号把每个 MIoT 属性都做成独立实体)
>
> 想知道你这台到底是哪种,HA 设置 → 工具 → 模板,粘这一行:
> ```jinja
> {% for id in states | list if 'isa_dw2hl' in id %}{{ id }} = {{ states[id].state }}
> {% endfor %}
> ```
> 本仓库的自动化**两种都认**,所以只要设备能被 HA 读到电量,就一定能推出去。
>
> 为什么不用 `numeric_state` + `attribute:` 当触发器:
> 万一电量不在属性上,那个触发器会**永远不响**,而且 HA 不报错。
> 改成「定时器 + 读的时候再取」之后,取不到就干脆不发 —— 看板显示"不知道",不撒谎。

> ★ 电量读数**不会**刷新 doorwatch 的心跳。
> 服务端认得出来:电量是「顺便报一下的」,不能证明「门状态刚刚读到过」。
> 一台没电的设备要是还在报电量,看板必须继续显示「状态未知」。
> 同理,电量读数超过 7 天(`BATTERY_TIMEOUT_MS`)就不认了 ——
> 设备可能早就没了,而我们手里还留着它最后上报的 87%。
>
> 还有一条:**broker 重放的 retained 旧电量消息只更新数字、不更新时间戳。**
> 服务端每次重启都会重新订阅,broker 会把 retained 存储里的旧消息重放一遍 ——
> 那条消息是什么时候读到的没人知道,写上「现在」就是拿过期读数冒充新的。
> 所以时间戳只认真正新鲜送达的消息。

### 数据会不会出户

走云端 = 门磁的开合记录会经过小米云(中国大陆机房)。
只是开关状态,没有身份信息,但如果你所在学校对数据出户有规定,先跟行政确认一下。

想全本地:刷社区网关固件(ESPHome 版 aqara-gateway 之类),但小米蓝牙网关刷第三方固件
**基本不可行**(没有公开的刷写方式)。这条路对蓝牙网关是死的 —— 对 Zigbee 网关才有可能。

---

## 附:文件清单

| 文件 | 作用 |
|---|---|
| [`ha/CHECKLIST.md`](CHECKLIST.md) | **门磁已接入 HA 之后的落地清单** —— 6 步操作 + 验收用例 + 故障对照表 |
| `ha/templates.yaml` | 归一化门状态 → `OPEN` / `CLOSED` / `UNKNOWN`,含方向开关和新鲜度判据 |
| `ha/automations.yaml` | 四条自动化:状态变化即时上报 / 每分钟体检 / HA 启动补发 / 电量上报 |
| `tools/ha-probe.mjs` | 探针:列出门磁候选实体、验方向、看哪个时间戳在推进 |
| `ha/README.md` | 本文件 |

---

## 附:doorwatch 服务端怎么理解 HA 发来的东西

三种消息,服务端各自的处理(见 `server/src/broker.js`):

| 主题 | 载荷 | 服务端怎么处理 |
|---|---|---|
| `doorwatch/<id>/state` | `OPEN` / `CLOSED` | 记为门状态,并刷新心跳 |
| `doorwatch/<id>/state` | **`UNKNOWN`** | **状态打回「未知」+ 标记离线** ——「我不知道」不是垃圾值 |
| `doorwatch/<id>/status` | `online` / `offline` | 标记在线/离线;离线时立刻降级为未知 |
| `doorwatch/<id>/heartbeat` | `alive` | 只证明「设备还活着」,**不会**把状态从「未知」变回开/关 |

几个容易误解的点:

- **`UNKNOWN` 会被认真对待。**
  早先的版本把 `UNKNOWN` 当成「看不懂的垃圾值」扔掉了,只刷新心跳不改状态 ——
  结果传感器明明已经死了,看板还一直显示「门开着」。现在改成:
  收到 `UNKNOWN` 立刻把状态打回 unknown 并标记离线。
- **心跳不会复活旧状态。**
  心跳只回答「设备此刻还活着吗」,不回答「门是开是关」。
  状态一旦被打回「未知」,必须再来一条合法的 `OPEN`/`CLOSED` 才恢复。
- **完全看不懂的载荷**(比如 `WHATEVER`)会被忽略并打告警,
  不会刷新心跳 —— 一刷新就等于承认「这是一次有效读数」。
- **broker 重放的 retained 旧消息**只更新状态,不算「设备还活着」。
  (实测 aedes:实时转发 `retain=false`,只有重放才是 `retain=true`。
  这条保护的是「服务端重启后,几天前的旧状态诈尸」这种场景。)
