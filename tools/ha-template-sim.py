#!/usr/bin/env python3
"""
离线复刻 Home Assistant 的模板语义,在不装 HA 的前提下验证 ha/templates.yaml。

复刻了这些(全部对照 HA 2026.10 源码):
  · helpers/template/__init__.py
      - TemplateEnvironment(ImmutableSandboxedEnvironment) 只设了
        undefined=make_logging_undefined(strict=False) 和 finalize=_finalize_output,
        **没有**开 trim_blocks / lstrip_blocks  → 空白原样保留
      - render_complex() 末尾对结果 .strip()
  · helpers/template/states.py
      - _get_state_if_valid(): 实体不存在 → 返回 None(不是抛错)
  · helpers/template/extensions/datetime.py
      - as_timestamp(value): 非 datetime → parse_datetime(str(value)),
        解析不出来就 raise_no_default → TemplateError
  · util/dt.py
      - as_timestamp(): 解析不出来 raise ValueError("not a valid date/time.")
  · components/template/binary_sensor.py
      - state 用 template.result_as_boolean(result) 转成 on/off
  · components/template/template_entity.py
      - 渲染抛 TemplateError → _attr_available = False → 实体变成 unavailable

依赖: pip install jinja2
用法:
    node tools/dump-ha-templates.mjs
    python tools/ha-template-sim.py        # 退出码 0 = 全部场景都渲染正常
"""
import datetime as dt
import json
import pathlib
import sys

try:
    import jinja2
except ImportError:
    print("⚠️ 缺 jinja2,跳过模板仿真: python -m pip install jinja2")
    sys.exit(0)

ROOT = pathlib.Path(__file__).resolve().parent.parent
JSON_PATH = ROOT / "tools" / ".ha-templates.json"
JSON_AUTO_PATH = ROOT / "tools" / ".ha-automations.json"

ENTITY = "binary_sensor.isa_dw2hl_b95b_magnet_sensor"
READABLE = "binary_sensor.doorwatch_it_office_door_readable"
STATE_ENTITY = "sensor.doorwatch_it_office_door_state"


class LoggingUndefined(jinja2.Undefined):
    """HA 用的是 jinja2.Undefined 的子类(非 strict),语义一致。"""

    def _log_message(self):  # HA 会打日志,这里静音
        pass


class State:
    """模拟 HA 的 TemplateState(继承 core.State)。"""

    def __init__(self, entity_id, state, last_updated, last_reported=None):
        self.entity_id = entity_id
        self.state = state
        self.last_updated = last_updated
        if last_reported is not None:
            self.last_reported = last_reported

    def __eq__(self, other):
        """对齐 homeassistant/core.py 的 State.__eq__。

        ★ 这里踩过坑,别改回去:
          HA 的 State.__eq__ 比的是 **entity_id**,而且只跟另一个 State 比:
              return isinstance(other, State) and self.entity_id == other.entity_id

          所以在模板里写 `src in ['on', 'off']` 或 `src == 'on'` —— **恒为 False**。
          `src` 是状态对象,不是状态文本;要拿文本必须写 `src.state`。

          早先这个仿真器写成「按 state 字符串比」,结果仿真一路绿灯,
          真实的 HA 却因为 `src in ['on','off']` 恒 False 而永远输出 UNKNOWN。
          仿真器比真实行为宽松,比模板宽松更危险 —— 它会掩盖 bug。
        """
        return isinstance(other, State) and self.entity_id == other.entity_id

    def __hash__(self):
        return hash(self.entity_id)

    def __str__(self):
        return f"{self.entity_id}={self.state}"

    def __bool__(self):
        return True


class DomainStates:
    def __init__(self, mapping, domain):
        self._m = mapping
        self._d = domain

    def __getattr__(self, name):
        # HA:_get_state_if_valid() —— 实体不存在返回 None
        return self._m.get(f"{self._d}.{name}")

    def __getitem__(self, name):
        return self.__getattr__(name)


class States:
    def __init__(self, mapping):
        self._m = mapping

    def __getattr__(self, name):
        if "." in name:
            return self._m.get(name)
        return DomainStates(self._m, name)

    def __getitem__(self, name):
        return self.__getattr__(name)

    def __call__(self, entity_id):
        """states('x') 只返回**状态文本**;实体不存在时 HA 返回 'unknown'。

        ★ 这跟 states.x 的对象写法完全不同 ——
          states.x.last_reported  → 时间戳
          states('x').last_updated → 报错(字符串上没有这个属性)
        """
        st = self._m.get(entity_id)
        return st.state if st is not None else "unknown"


def parse_datetime(value):
    if not isinstance(value, str):
        return None
    try:
        return dt.datetime.fromisoformat(value)
    except ValueError:
        return None


def as_timestamp(value, default=jinja2.Undefined):
    """对齐 helpers/template/extensions/datetime.py 的 as_timestamp。"""
    try:
        if isinstance(value, dt.datetime):
            parsed = value
        else:
            parsed = parse_datetime(str(value))
        if parsed is None:
            raise ValueError("not a valid date/time.")
        return parsed.timestamp()
    except (TypeError, ValueError):
        if default is jinja2.Undefined:
            raise jinja2.TemplateError(
                f"Template error: as_timestamp got invalid input {value!r}"
            ) from None
        return default


def now():
    return dt.datetime.now(dt.timezone.utc)


def make_env():
    env = jinja2.Environment(
        undefined=LoggingUndefined,
        extensions=["jinja2.ext.loopcontrols", "jinja2.ext.do"],
    )
    env.globals.update({"as_timestamp": as_timestamp, "now": now})
    return env


def result_as_boolean(result):
    """对齐 helpers/template/helpers.py 的 result_as_boolean。"""
    if result is None:
        return False
    if isinstance(result, bool):
        return result
    if isinstance(result, str):
        return result.strip().lower() in ("1", "true", "yes", "on", "enable", "enabled")
    return bool(result)


def render_raw(tpl_text, mapping):
    env = make_env()
    env.globals["states"] = States(mapping)
    return env.from_string(tpl_text).render()


def templates_from_disk():
    """读 tools/.ha-templates.json —— 由 tools/dump-ha-templates.mjs 生成。"""
    if not JSON_PATH.exists():
        return []
    try:
        return json.loads(JSON_PATH.read_text(encoding="utf8"))
    except json.JSONDecodeError:
        return []


def fuses_from_disk():
    """读 tools/.ha-automations.json —— 自动化里的「模板条件」(保险丝)。"""
    if not JSON_AUTO_PATH.exists():
        return []
    try:
        return json.loads(JSON_AUTO_PATH.read_text(encoding="utf8"))
    except json.JSONDecodeError:
        return []


def to_ha_state(platform, raw):
    """把渲染结果变成 HA 里实体真正会显示的状态值。"""
    out = raw.strip()  # HA: helpers/template/__init__.py:494
    if platform == "binary_sensor":
        return "on" if result_as_boolean(out) else "off"
    return out


def scenarios():
    n = dt.datetime.now(dt.timezone.utc)
    fresh = n - dt.timedelta(seconds=10)
    stale = n - dt.timedelta(seconds=600)
    return [
        ("实体不存在(名字写错/集成没加载)", {}),
        ("门关着,刚上报(10 秒前)", {ENTITY: State(ENTITY, "off", fresh, fresh)}),
        ("门关着,已失联(600 秒前)", {ENTITY: State(ENTITY, "off", stale, stale)}),
        ("实体 unavailable,刚上报", {ENTITY: State(ENTITY, "unavailable", fresh, fresh)}),
        ("门开着,刚上报", {ENTITY: State(ENTITY, "on", fresh, fresh)}),
        ("旧版 HA:没有 last_reported", {ENTITY: State(ENTITY, "off", fresh)}),
        # seen 不是 datetime —— as_timestamp() 遇到它会抛 ValueError → TemplateError
        ("上报时间取不到(不是 datetime)", {ENTITY: State(ENTITY, "off", fresh, "unknown")}),
    ]


# =====================================================================
#  旧模板为什么是坏的 —— 留档,别把同样的坑再踩一遍
# =====================================================================
#
#  线上真实事故(2026-10):HA 里跑着旧版 templates.yaml,
#  现象是「sensor.doorwatch_it_office_door_state = unavailable,
#  而同一个文件里的 readable 模板却能正常渲染出 False」。
#
#  两个模板用的是同一个源实体、同一个新鲜度判据,结果一个炸一个不炸,
#  看着毫无关系。真正的原因有两层:
#
#  ① as_timestamp() 只认 datetime。喂 Undefined 或字符串 →
#     parse_datetime(str(value)) 失败 → ValueError → TemplateError
#     → 实体被 HA 置成 unavailable。
#
#  ② Jinja 的 `and` 是短路的,而且**短路救不救得看表达式放在哪**:
#     · door_state: as_timestamp() 在**独立的 {% set %}** 里 → 无条件求值 → 炸
#     · readable:   as_timestamp() 在 **{% if %} 的 and 链末端**,
#                   前面 `src in ['on','off']` 为 False → 整条链短路 → 压根不求值 → 活
#
#  还有一个独立的、跟 unavailable 无关的致命 bug:
#     `src in ['on','off']` —— src 是**状态对象**,
#     HA 的 State.__eq__ 比的是 entity_id,所以这一句**恒为 False**。
#     旧 door_state 因此永远输出 UNKNOWN,哪怕门开着、传感器刚上报过。
#
LEGACY_STATE_TPL = """{% set src = states.binary_sensor.isa_dw2hl_b95b_magnet_sensor %}
{% set DOOR_ON_MEANS_OPEN = true %}
{% set STALE_SECONDS = 180 %}
{% set seen = src.last_reported | default(src.last_updated, true) %}
{% set alive = seen is defined and seen is not none
              and (as_timestamp(now()) - as_timestamp(seen)) < STALE_SECONDS %}
{% if src in ['on', 'off'] and alive %}
  {% set is_open = (src == 'on') == DOOR_ON_MEANS_OPEN %}
  {{ 'OPEN' if is_open else 'CLOSED' }}
{% else %}
  {{ 'UNKNOWN' }}
{% endif %}"""

LEGACY_READABLE_TPL = """{% set STALE_SECONDS = 180 %}
{% set src = states.binary_sensor.isa_dw2hl_b95b_magnet_sensor %}
{% set seen = src.last_reported | default(src.last_updated, true) %}
{% if src in ['on', 'off'] and seen is defined and seen is not none
      and (as_timestamp(now()) - as_timestamp(seen)) < STALE_SECONDS %}
  {{ true }}
{% else %}
  {{ false }}
{% endif %}"""


# =====================================================================
#  保险丝 —— 自动化里的「传感器还活着吗」
# =====================================================================
#
#  ★★ 线上事故(2026-11):保险丝用的是**模板实体**的 last_reported。
#     而 HA 只在渲染结果**变化**时才把状态写回 state machine:
#
#       helpers/event.py → TrackTemplateResultInfo._render_template_if_ready
#           if result == last_result and template in self._last_result:
#               return True      # ← 结果没变,连 update 都不产生
#
#     结果没变 → 不产生 update → 回调不跑 → async_write_ha_state() 不跑
#     → 状态压根没被写进 state machine → **last_reported 永远不动**。
#
#     于是模板实体的 last_reported 冻结在「值最后一次变化」的那一刻,
#     保险丝两分钟后必然判成「过期」→ 每分钟推 offline
#     → 看板永远显示「状态未知」—— 而门磁明明好好的。
#
#     原始门磁就不一样:xiaomi_miot 每轮轮询都写一次状态,
#     值没变时 HA 走 async_set_internal 的「提前返回」分支,
#     **只更新 last_reported** —— 它的 last_reported 是真在推进的。
#
LEGACY_FUSE = """{% set r = states.binary_sensor.doorwatch_it_office_door_readable %}
{% set ts = r.last_reported | default(r.last_updated, true) %}
{% set ok = false %}
{% if r is not none and r.state == 'on' and ts is defined and ts is not none
       and ts.year is defined %}
  {% set ok = (as_timestamp(now()) - as_timestamp(ts)) < 120 %}
{% endif %}
{{ ok }}"""


def legacy_regressions():
    """重现线上事故的现象,并确认新版模板已经修好。返回问题数。"""
    n = dt.datetime.now(dt.timezone.utc)
    fresh = n - dt.timedelta(seconds=10)
    bad_seen = {ENTITY: State(ENTITY, "off", fresh, "unknown")}
    open_fresh = {ENTITY: State(ENTITY, "on", fresh, fresh)}

    failures = 0
    print("=" * 76)
    print("旧模板事故复现(留档)")
    print("-" * 76)

    def show(label, tpl, mapping):
        try:
            out = render_raw(tpl, mapping).strip()
            print(f"  {label:<44} → {out!r}")
            return out
        except Exception as exc:  # noqa: BLE001
            print(f"  {label:<44} → ✗ {type(exc).__name__}")
            return None

    # ① 旧 door_state:门开着、刚上报,却报 UNKNOWN(src in [...] 恒 False)
    out = show("旧 door_state(门开着、10 秒前上报)", LEGACY_STATE_TPL, open_fresh)
    if out != "UNKNOWN":
        print("       ✗ 预期是 UNKNOWN —— 说明仿真器的 State.__eq__ 又被改松了")
        failures += 1
    else:
        print("       ✓ 复现:`src in ['on','off']` 恒 False,门开着也报 UNKNOWN")

    # ② 旧 door_state:seen 不是 datetime → TemplateError → unavailable
    print("       (HA 里表现为:实体 = unavailable)")
    out = show("旧 door_state(上报时间不是 datetime)", LEGACY_STATE_TPL, bad_seen)
    if out is not None:
        print("       ✗ 预期是抛异常(→ unavailable)")
        failures += 1
    else:
        print("       ✓ 复现:渲染抛异常,HA 里实体变 unavailable")

    # ③ 旧 readable:同一个表达式在 and 链末端 → 被短路救活
    out = show("旧 readable(上报时间不是 datetime)", LEGACY_READABLE_TPL, bad_seen)
    if out != "False":
        print("       ✗ 预期是 'False' —— and 链短路救活了它")
        failures += 1
    else:
        print("       ✓ 复现:同一个表达式,靠 and 短路活了下来 → 这就是那个不对称")

    # ④ 旧保险丝:模板实体的 last_reported 冻结着 → 永远判「过期」
    print("       (HA 里表现为:每分钟推 offline,看板永远「状态未知」)")
    frozen = n - dt.timedelta(minutes=30)
    fuse_map = {
        ENTITY: State(ENTITY, "off", fresh, fresh),
        READABLE: State(READABLE, "on", frozen, frozen),
        STATE_ENTITY: State(STATE_ENTITY, "CLOSED", frozen, frozen),
    }
    out = show("旧保险丝(模板 last_reported 冻结在 30 分钟前)", LEGACY_FUSE, fuse_map)
    if out != "False":
        print("       ✗ 预期是 'False'")
        failures += 1
    else:
        print("       ✓ 复现:模板实体的 last_reported 不推进 → 保险丝永远不通过")

    print("-" * 76)
    print("新版模板(仓库里现在这份)在这两种输入下的表现:")
    for label, mapping in (
        ("门开着、10 秒前上报", open_fresh),
        ("上报时间不是 datetime", bad_seen),
    ):
        for tpl in templates_from_disk():
            try:
                raw = render_raw(tpl["state"], mapping)
                state = to_ha_state(tpl["platform"], raw)
                print(f"  {tpl['unique_id']:<34} {label:<22} → {state!r}")
                if tpl["platform"] == "sensor" and state not in ("OPEN", "CLOSED", "UNKNOWN"):
                    print("       ✗ 状态值必须是 OPEN/CLOSED/UNKNOWN 之一")
                    failures += 1
            except Exception as exc:  # noqa: BLE001
                print(f"  {tpl['unique_id']:<34} {label:<22} → ✗ {type(exc).__name__}: {exc}")
                print("       ✗ 新版模板不应该再炸")
                failures += 1
    print("")
    return failures


def fuse_scenarios():
    """把仓库里的保险丝在几种场景下跑一遍。返回问题数。"""
    n = dt.datetime.now(dt.timezone.utc)
    fresh = n - dt.timedelta(seconds=10)
    stale = n - dt.timedelta(seconds=600)
    # 模板实体的 last_reported:冻结在「值最后一次变化」的那一刻(见上面的说明)
    frozen = n - dt.timedelta(minutes=30)

    def mapping(raw_rep, raw_state, readable_state, state_value):
        return {
            ENTITY: State(ENTITY, raw_state, raw_rep, raw_rep),
            READABLE: State(READABLE, readable_state, frozen, frozen),
            STATE_ENTITY: State(STATE_ENTITY, state_value, frozen, frozen),
        }

    cases = [
        ("一切正常(原始门磁 10 秒前上报)", mapping(fresh, "off", "on", "CLOSED"), True),
        ("原始门磁已失联(600 秒前)", mapping(stale, "off", "on", "CLOSED"), False),
        ("可读性模板说读不到", mapping(fresh, "off", "off", "CLOSED"), False),
        ("状态模板给不出明确答案(UNKNOWN)", mapping(fresh, "off", "on", "UNKNOWN"), False),
    ]

    failures = 0
    print("=" * 76)
    print("保险丝(自动化里的「传感器还活着吗」)")
    print("-" * 76)

    fuses = fuses_from_disk()
    if not fuses:
        print("  没读到保险丝模板,先跑 node tools/dump-ha-templates.mjs")
        return 1

    for f in fuses:
        print(f"  {f.get('alias') or f.get('id')}")
        for label, m, expected in cases:
            try:
                out = render_raw(f["fuse"], m).strip()
                got = out.lower() in ("true", "yes", "on", "1")
                mark = "✓" if got == expected else "✗"
                print(f"    {mark} {label:<40} → {out!r}")
                if got != expected:
                    failures += 1
            except Exception as exc:  # noqa: BLE001
                print(f"    ✗ {label:<40} → {type(exc).__name__}: {exc}")
                failures += 1
        print("")

    print("-" * 76)
    print("对照:旧保险丝在同一组输入下的表现")
    for label, m, expected in cases:
        try:
            out = render_raw(LEGACY_FUSE, m).strip()
            got = out.lower() in ("true", "yes", "on", "1")
            mark = "✓" if got == expected else "✗"
            print(f"  {mark} {label:<40} → {out!r}")
        except Exception as exc:  # noqa: BLE001
            print(f"  ✗ {label:<40} → {type(exc).__name__}: {exc}")
    print("")
    return failures


def main():
    if not JSON_PATH.exists():
        print("❌ 找不到 tools/.ha-templates.json,先跑: node tools/dump-ha-templates.mjs")
        return 1
    templates = templates_from_disk()
    if not templates:
        print("❌ 没有解析出任何模板")
        return 1

    failures = 0
    print("=" * 76)
    for tpl in templates:
        platform = tpl["platform"]
        print(f"模板 {tpl['unique_id']}   [platform={platform}]")
        print("-" * 76)
        for label, mapping in scenarios():
            try:
                raw = render_raw(tpl["state"], mapping)
                state = to_ha_state(platform, raw)
                print(f"  {label:<36} → {state!r}")
                if platform == "binary_sensor" and state not in ("on", "off"):
                    print("       ✗ binary_sensor 的状态只能是 on/off")
                    failures += 1
                if platform == "sensor" and state not in ("OPEN", "CLOSED", "UNKNOWN"):
                    print("       ✗ 状态值必须是 OPEN/CLOSED/UNKNOWN 之一")
                    failures += 1
            except Exception as exc:  # noqa: BLE001
                # HA:模板抛 TemplateError → 实体变成 unavailable
                print(f"  {label:<36} → ✗ {type(exc).__name__}: {exc}")
                print("       ✗ HA 里这个实体会变成 unavailable")
                failures += 1
        print("")

    failures += legacy_regressions()
    failures += fuse_scenarios()

    print("=" * 76)
    if failures:
        print(f"❌ {failures} 处问题")
    else:
        print("✅ 所有模板在所有场景下都渲染正常,不会变成 unavailable")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
