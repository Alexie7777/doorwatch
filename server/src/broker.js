import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import mqtt from 'mqtt';
import { Aedes } from 'aedes';
import { config } from './config.js';
import { recordState, recordSeen, recordUnknown, recordBattery, setOnline, getDoorByDevice } from './db.js';
import { normalizeState } from './state.js';
import { pushState } from './live.js';

/**
 * MQTT 接入层。
 *
 * 默认跑一个内置 broker(aedes),这样整套东西是一个容器,
 * 扔到任意一台有 Docker 的机器上就能用,不用再单独维护 Mosquitto。
 * 如果学校已经有 broker,设 MQTT_HOST 就能接过去。
 *
 * 约定的主题(doorwatch = TOPIC_PREFIX):
 *   doorwatch/<deviceId>/state     -> OPEN | CLOSED
 *   doorwatch/<deviceId>/status    -> online | offline   (遗嘱消息,掉线时 Broker 自动发)
 *   doorwatch/<deviceId>/heartbeat -> alive              (60s 一跳,用来判断传感器还活着)
 *   doorwatch/<deviceId>/battery   -> 87                 (电量百分比 0-100,可选)
 *
 * ★ battery 是**可选**的一路:它只更新电量,绝不刷新心跳、不改状态。
 *   电量消息不能证明"门状态刚刚读到过"。
 */

let broker = null;
let netServer = null;
let tlsServer = null;
let client = null;
/** 已经提醒过的未登记设备,避免刷屏 */
const warnedDevices = new Set();
/**
 * 当前连在 broker 上的客户端数量(HA、ESPHome 设备都算)。
 * 排查「HA 到底连上 MQTT 没有」时,这是最直接的证据。
 */
let clientCount = 0;

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
}

/** 启动内置 broker(仅当没配置外部 broker 时) */
async function startEmbeddedBroker() {
  broker = await Aedes.createBroker();

  broker.on('client', (client) => {
    clientCount += 1;
    console.log(`[mqtt] 传感器接入: ${client.id}(当前 ${clientCount} 个客户端在线)`);
  });
  broker.on('clientDisconnect', () => {
    clientCount = Math.max(0, clientCount - 1);
  });
  broker.on('connectionError', (client, err) => {
    console.warn(`[mqtt] 连接异常: ${err?.message ?? err}`);
  });
  broker.on('clientError', (client, err) => {
    console.warn(`[mqtt] 客户端异常: ${err?.message ?? err}`);
  });

  netServer = net.createServer(broker.handle);
  await listen(netServer, config.mqttPort, config.host);
  console.log(`[mqtt] 内置 broker 已启动: 0.0.0.0:${config.mqttPort}`);

  if (config.mqttTlsPort > 0) {
    tlsServer = tls.createServer(
      { key: fs.readFileSync(config.certKey), cert: fs.readFileSync(config.certCrt) },
      broker.handle,
    );
    await listen(tlsServer, config.mqttTlsPort, config.host);
    console.log(`[mqtt] 内置 broker TLS 端口: ${config.mqttPort} -> ${config.mqttTlsPort}`);
  }
}

/**
 * 处理一条传感器消息
 *
 * @param {object} packet  MQTT 包
 *   packet.retain === true 表示这条是 broker 重放的 retained 旧消息
 *   (订阅瞬间从 retained 存储里翻出来的历史数据),不是设备刚发来的。
 *   实测 aedes 的行为:实时转发一律 retain=false,只有重放才是 true。
 */
function handleMessage(topic, payload, packet) {
  const parts = topic.split('/');
  if (parts.length < 3) return;
  const kind = parts[parts.length - 1];
  const deviceId = parts[parts.length - 2];
  const text = payload.toString('utf8').trim();
  const fresh = !(packet && packet.retain);

  // 设备没登记就别吞掉消息 —— 静默丢弃是排障噩梦,直接喊出来
  if (!getDoorByDevice(deviceId)) {
    if (!warnedDevices.has(deviceId)) {
      warnedDevices.add(deviceId);
      console.warn(
        `[mqtt] 收到未登记设备 "${deviceId}" 的消息(${kind}),已忽略。` +
          `请检查 config/doors.json 里的 deviceId,或改固件里的 mqtt_topic_prefix。`,
      );
    }
    return;
  }

  if (!fresh) {
    console.log(
      `[mqtt] ${deviceId} 收到 broker 重放的旧消息(${kind}=${text}),` +
        `只更新状态,不当作"设备还活着"。`,
    );
  }

  switch (kind) {
    case 'state': {
      const state = normalizeState(text);

      // ★ 传感器明确说"我读不到"(HA 的模板在传感器失联时输出 UNKNOWN)。
      //   必须把状态打回 unknown —— 不能只刷新心跳然后继续显示上次的开/关。
      if (state === 'unknown') {
        const { changed } = recordUnknown(deviceId, Date.now(), { fresh });
        console.log(
          `[mqtt] ${deviceId} 上报 UNKNOWN -> 状态打回"未知"` +
            (changed ? '' : '(本来就是未知)'),
        );
        pushState();
        break;
      }

      if (!state) {
        // 完全看不懂的值:多半是版本不一致或发包出错。
        // 注意:这里**不能**刷新心跳 —— 一刷新就等于承认"这是一次有效读数",
        // 看板会继续显示旧状态,传感器真死了也不知道。
        // 也不改状态:设备还活着、心跳还在走,说明门的状态没变,
        // 保持最后一次合法读数是准确的;心跳超时那套机制负责兜底。
        console.warn(
          `[mqtt] ${deviceId} 上报了看不懂的状态: "${text}"(已忽略,` +
            `不会刷新心跳;请检查发送端)`,
        );
        break;
      }

      const { changed } = recordState(deviceId, state, Date.now(), { fresh });
      if (changed) {
        console.log(`[mqtt] ${deviceId} 状态 -> ${state}`);
        pushState();
      }
      break;
    }
    case 'status': {
      const online = text.toLowerCase() === 'online';
      setOnline(deviceId, online);
      if (online && fresh) recordSeen(deviceId);
      console.log(`[mqtt] ${deviceId} ${online ? '上线' : '离线'}`);
      pushState();
      break;
    }
    case 'heartbeat': {
      // 重放的心跳不算数 —— 心跳是"我此刻还活着"的证明,历史记录证明不了。
      if (fresh) recordSeen(deviceId);
      break;
    }
    case 'battery': {
      // 电量是"顺便报一下的",不是门状态的证明。
      // ★ 所以这里**不**调用 recordSeen —— 一台没电的设备要是还在报电量,
      //   看板就必须继续显示"传感器离线 / 状态未知",不能被电量消息救活。
      //
      // ★ 重放的 retained 旧消息只更新数字,不更新时间戳:
      //   我们不知道那条消息是什么时候读到的,写上 now 就是撒谎。
      const level = Number.parseInt(text, 10);
      if (!Number.isFinite(level) || level < 0 || level > 100) {
        console.warn(
          `[mqtt] ${deviceId} 上报了看不懂的电量: "${text}"(已忽略,` +
            `应为 0-100 的整数)`,
        );
        break;
      }
      const { changed } = recordBattery(deviceId, level, Date.now(), { fresh });
      if (changed) {
        console.log(
          `[mqtt] ${deviceId} 电量 -> ${level}%` + (fresh ? '' : '(broker 重放,没记时间戳)'),
        );
        pushState();
      }
      break;
    }
    default:
      break;
  }
}

/**
 * 启动客户端并订阅传感器主题。
 * 返回一个 Promise:订阅成功就 resolve。
 *
 * 为什么等订阅:
 *   订阅的瞬间 broker 会把 retained 存储里的旧消息重放一遍。
 *   如果看板先开门、订阅后建,这两件事之间传感器发的消息会被漏掉
 *   (retain=false 的话直接丢),用户会看到一块"什么都没有"的看板。
 *   所以宁可晚 100 毫秒开门,也要先把订阅坐稳。
 */
function startClient() {
  const url = config.mqttHost
    ? `mqtt://${config.mqttHost}:${config.mqttPortExternal}`
    : `mqtt://127.0.0.1:${config.mqttPort}`;

  return new Promise((resolve) => {
    client = mqtt.connect(url, {
      username: config.mqttUsername || undefined,
      password: config.mqttPassword || undefined,
      reconnectPeriod: 3000,
      connectTimeout: 10_000,
      clean: true,
    });

    client.on('connect', () => {
      console.log(`[mqtt] 已连接 broker: ${url}`);
      const p = config.topicPrefix;
      client.subscribe(
        [`${p}/+/state`, `${p}/+/status`, `${p}/+/heartbeat`, `${p}/+/battery`],
        (err) => {
          if (err) console.error('[mqtt] 订阅失败:', err.message);
          else console.log(`[mqtt] 已订阅 ${p}/+/{state,status,heartbeat,battery}`);
          resolve();
        },
      );
    });

    client.on('message', (topic, payload, packet) => handleMessage(topic, payload, packet));
    client.on('error', (err) => console.warn('[mqtt] 客户端错误:', err.message));
    client.on('reconnect', () => console.log('[mqtt] 正在重连 broker...'));
    client.on('offline', () => console.warn('[mqtt] 与 broker 断开'));
  });
}

export async function startBroker() {
  if (!config.mqttHost) {
    await startEmbeddedBroker();
  } else {
    console.log(`[mqtt] 使用外部 broker: ${config.mqttHost}:${config.mqttPortExternal}`);
  }
  // 最多等 10 秒:外部 broker 暂时连不上时,看板照样要能开
  // —— 否则 broker 一挂,连"状态未知"都看不到了。
  await Promise.race([
    startClient(),
    new Promise((r) => setTimeout(r, 10_000)),
  ]);
}

export async function stopBroker() {
  try {
    client?.end(true);
  } catch {
    /* ignore */
  }
  await new Promise((resolve) => (netServer ? netServer.close(resolve) : resolve()));
  await new Promise((resolve) => (tlsServer ? tlsServer.close(resolve) : resolve()));
  if (broker) {
    await new Promise((resolve) => broker.close(resolve));
  }
}

export function brokerStatus() {
  return {
    embedded: !config.mqttHost,
    brokerPort: config.mqttHost ? config.mqttPortExternal : config.mqttPort,
    clientConnected: Boolean(client?.connected),
    /** 当前连在 broker 上的客户端数(HA / ESPHome 设备都算) */
    clients: clientCount,
    topicPrefix: config.topicPrefix,
  };
}
