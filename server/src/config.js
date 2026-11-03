import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(moduleDir, '../..');

function env(key, fallback = '') {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function envInt(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function envList(key) {
  return env(key)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 定位前端静态资源目录。
 * 和 BBall 一样,CWD 在开发/本地/Docker 三种运行方式下各不相同,
 * 所以按候选列表逐个探测,取第一个真的带 index.html 的目录。
 */
function resolvePublicDir() {
  const override = process.env.PUBLIC_DIR;
  if (override) return path.resolve(override);
  const candidates = [
    path.resolve(moduleDir, '../../public'), // 源码目录
    path.resolve(process.cwd(), 'public'), // Docker WORKDIR=/app
    path.resolve(process.cwd(), '../public'),
    path.resolve(rootDir, 'public'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return candidates[0];
}

export const config = {
  /** HTTPS 监听端口(主端口) */
  port: envInt('PORT', 8443),
  /** 额外开一个纯 HTTP 端口(仅用于内网跳转/健康检查),0 表示不开 */
  httpPort: envInt('HTTP_PORT', 0),
  host: env('HOST', '0.0.0.0'),

  /** 数据目录(SQLite / 自签证书) */
  dataDir: path.resolve(env('DATA_DIR', path.join(rootDir, 'data'))),

  /** 是否启用 HTTPS。手机加到主屏幕(PWA)需要安全上下文 */
  https: envBool('HTTPS', true),

  /**
   * 自签证书的额外域名/IP(逗号分隔)。
   * 例:CERT_NAMES=doorwatch.school.edu,192.168.1.20
   * 不填的话会自动把本机所有内网 IPv4 都写进 SAN。
   */
  certNames: envList('CERT_NAMES'),

  /** 自带证书:指定外部证书(学校内网 CA 签发的那种) */
  certFile: env('CERT_FILE', ''),
  keyFile: env('KEY_FILE', ''),

  /** 生成自签证书时用的 openssl 可执行文件路径(留空则自动探测) */
  opensslPath: env('OPENSSL_PATH', ''),

  /** MQTT 主题前缀,传感器统一发到 doorwatch/<deviceId>/xxx */
  topicPrefix: env('TOPIC_PREFIX', 'doorwatch'),

  /** 内置 MQTT broker 的 TCP 端口 */
  mqttPort: envInt('MQTT_PORT', 1883),
  /** 内置 MQTT broker 的 TLS 端口(0 表示不开) */
  mqttTlsPort: envInt('MQTT_TLS_PORT', 0),

  /**
   * 外部 MQTT broker。留空则使用内置 broker(单容器部署,推荐)。
   * 例:MQTT_HOST=10.0.0.5  MQTT_USERNAME=esp  MQTT_PASSWORD=xxx
   */
  mqttHost: env('MQTT_HOST', ''),
  mqttPortExternal: envInt('MQTT_PORT_EXTERNAL', 1883),
  mqttUsername: env('MQTT_USERNAME', ''),
  mqttPassword: env('MQTT_PASSWORD', ''),

  /**
   * 传感器心跳超时(毫秒)。超过这个时间没收到心跳,一律按"状态未知"处理。
   * 传感器默认 60s 一跳,所以 180s 允许连续丢 3 个包。
   */
  onlineTimeoutMs: envInt('ONLINE_TIMEOUT_MS', 180_000),

  /**
   * 电池读数多久算过期(毫秒)。默认 7 天。
   *
   * 为什么电量也要有超时:
   *   电量是"上一次读到的数",不是"现在的数"。设备可能早就没电了,
   *   而我们手里还留着它最后一次上报的 87%。
   *   放太久还不认,看板上就会出现一个看着很正常、其实早就没意义的数字。
   *   —— 跟状态那块一样的原则:宁可说不知道,不要拿过期数据糊弄人。
   */
  batteryTimeoutMs: envInt('BATTERY_TIMEOUT_MS', 7 * 24 * 3600_000),

  /** 隐藏具体时间,只显示开/关。用于不想对外暴露人员出入时间的场景 */
  hideTimes: envBool('HIDE_TIMES', false),

  /**
   * 值班微信的二维码图片路径。
   *
   * 提示语里写 `[值班微信](wechat)`,前端就会把「值班微信」渲染成一个可点的按钮,
   * 点一下弹出这个二维码。留空 = 不配二维码,那句话就当普通文字显示。
   */
  wechatQr: env('WECHAT_QR', '/wechat-qr.jpg'),

  /** 写操作密钥。留空则首次启动自动生成并写入 dataDir/ADMIN_KEY.txt */
  adminKey: env('ADMIN_KEY', ''),

  /** 门禁登记表文件路径 */
  doorsFile: path.resolve(env('DOORS_FILE', path.join(rootDir, 'config', 'doors.json'))),

  /** 直接用 JSON 字符串配置门禁(容器部署时比挂载文件方便) */
  doorsJson: env('DOORS_JSON', ''),

  publicDir: resolvePublicDir(),
  version: '1.0.0',
};

export const paths = {
  db: path.join(config.dataDir, 'doorwatch.db'),
  cert: path.join(config.dataDir, 'cert'),
  certKey: path.join(config.dataDir, 'cert', 'server.key'),
  certCrt: path.join(config.dataDir, 'cert', 'server.crt'),
  adminKeyFile: path.join(config.dataDir, 'ADMIN_KEY.txt'),
};
