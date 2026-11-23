import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import {
  claimDigest, digestStatus, finishDigest, installDigests,
  prepareDigest, readDigest, scheduleFor, transaction,
} from './digests.mjs';

const commands = {
  plan: [],
  ingest: ['input'],
  queue: [],
  prepare: ['round', 'refresh'],
  digest: ['round', 'day'],
  'claim-digest': ['round'],
  'finish-digest': ['attempt', 'result', 'note'],
  finish: ['attempt', 'result', 'note'],
  status: [],
};

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''));
}

function clean(value) {
  return typeof value === 'string' ? value.normalize('NFC').trim() : '';
}

function readConfig(path) {
  const config = readJson(path);
  requireValue(Array.isArray(config.sources) && config.sources.length, '配置至少一个来源。');
  if (config.subscriptionsFile) {
    const selectionPath = resolve(dirname(path), config.subscriptionsFile);
    if (existsSync(selectionPath)) {
      const { sources } = readJson(selectionPath);
      requireValue(Array.isArray(sources) && sources.every(source => source?.kind === 'article'),
        '选择文件需要 HTML 导出的公众号列表。');
      const configured = new Map(config.sources.map(source => [source.id, source]));
      config.sources.push(...sources.filter(source => {
        const existing = configured.get(source.id);
        return existing?.kind !== source.kind || clean(existing.name) !== clean(source.name);
      }));
    }
  }
  const ids = new Set();
  for (const source of config.sources) {
    requireValue(/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(source.id ?? '') && !ids.has(source.id),
      '每个来源需要唯一的英文 id。');
    requireValue(['article', 'video'].includes(source.kind) && clean(source.name),
      '来源需要完整名称和 article 或 video 类型。');
    requireValue(source.required === undefined || typeof source.required === 'boolean',
      '来源的 required 需要是布尔值。');
    source.name = clean(source.name);
    ids.add(source.id);
  }
  const { schedule, delivery } = config;
  requireValue(schedule?.timezone && Array.isArray(schedule.times) && schedule.times.length === 2 &&
    schedule.times.every(time => /^([01]\d|2[0-3]):[0-5]\d$/u.test(time)) &&
    schedule.times[0] < schedule.times[1], '配置时区和两个按顺序排列的 HH:mm 定时时间。');
  new Intl.DateTimeFormat('en', { timeZone: schedule.timezone });
  schedule.leadMinutes ??= 30;
  const [first, late] = schedule.times.map(time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3)));
  requireValue(Number.isInteger(schedule.leadMinutes) && schedule.leadMinutes > 0 &&
    schedule.leadMinutes <= first && schedule.leadMinutes < late - first,
    '准备时间必须在当天，且两轮准备和发送时段不能重叠。');
  requireValue(typeof delivery?.enabled === 'boolean', '配置 delivery.enabled。');
  if (delivery.mode === 'native') {
    requireValue(clean(delivery.chatName), '配置微信聊天的完整名称。');
    delivery.chatName = clean(delivery.chatName);
  } else {
    requireValue(delivery.mode === 'clawbot' && /^[^:\s@]+@im\.wechat$/u.test(delivery.target ?? '') &&
      clean(delivery.accountId), 'ClawBot 需要已配对的私聊 target 和 accountId。');
  }
  return config;
}

function openStore(directory) {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(resolve(directory, 'wechat-rss.sqlite'));
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
      initialized_at TEXT, scanned_at TEXT, coverage TEXT, scan_note TEXT
    );
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), identity TEXT NOT NULL,
      title TEXT NOT NULL, url TEXT, locator TEXT NOT NULL, first_seen TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('baseline','pending','sending','sent'))
    );
    CREATE INDEX IF NOT EXISTS items_by_source ON items(source_id, first_seen);
    CREATE INDEX IF NOT EXISTS items_by_state ON items(state, first_seen);
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id),
      route TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
      result TEXT, note TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_attempt ON attempts(item_id) WHERE ended_at IS NULL;
  `);
  transaction(db, () => {
    if (!db.prepare('PRAGMA table_info(items)').all().some(column => column.name === 'author')) {
      db.exec('ALTER TABLE items ADD COLUMN author TEXT');
    }
    installDigests(db);
  });
  return db;
}

function normalizeEntry(source, entry) {
  const title = clean(entry.title);
  const locator = clean(entry.locator);
  let identity = clean(entry.identity);
  let url = null;
  if (clean(entry.url)) {
    const parsed = new URL(clean(entry.url));
    requireValue(parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port &&
      (parsed.hostname === 'weixin.qq.com' || parsed.hostname.endsWith('.weixin.qq.com')),
      '链接必须是微信客户端实际复制的 HTTPS 微信链接。');
    url = parsed.href;
    if (!identity && source.kind === 'article' && parsed.hostname === 'mp.weixin.qq.com') {
      const fields = ['__biz', 'mid', 'idx'].map(field => parsed.searchParams.get(field));
      if (parsed.pathname === '/s' && fields.every(Boolean)) identity = JSON.stringify(['article', ...fields]);
      if (/^\/s\/[\w-]+\/?$/u.test(parsed.pathname)) identity = parsed.pathname.replace(/\/$/u, '');
    }
  }
  requireValue(title && locator && identity && identity.length <= 1000,
    '每条内容都需要标题、重新定位线索和可复核的内容标识。');
  const id = createHash('sha256').update(source.id).update('\0').update(identity).digest('hex').slice(0, 24);
  return { id, title, identity, url, locator, author: clean(entry.author) || null };
}

function ingest(db, config, input, now) {
  const source = config.sources.find(candidate => candidate.id === input.sourceId);
  requireValue(source && ['complete', 'partial'].includes(input.coverage) && Array.isArray(input.items),
    '巡检结果需要配置中的 sourceId、complete 或 partial 覆盖状态、items 数组。');
  const items = input.items.map(entry => normalizeEntry(source, entry));
  requireValue(new Set(items.map(item => item.id)).size === items.length, '本次巡检有重复内容标识，请核对。');
  return transaction(db, () => {
    const stored = db.prepare('SELECT * FROM sources WHERE id = ?').get(source.id);
    requireValue(!stored || (stored.kind === source.kind && stored.name === source.name),
      '来源名称或类型与已有记录不同，请为新来源使用新 id。');
    const complete = input.coverage === 'complete';
    const baseline = !stored?.initialized_at;
    db.prepare(`INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET initialized_at = coalesce(sources.initialized_at, excluded.initialized_at),
      scanned_at = excluded.scanned_at, coverage = excluded.coverage, scan_note = excluded.scan_note`)
      .run(source.id, source.kind, source.name, baseline && complete ? now : null, now,
        input.coverage, clean(input.note) || null);

    if (baseline && !complete) return { baselined: 0, queued: 0, observed: 0, needsBaseline: true };
    let added = 0;
    const insert = db.prepare(`INSERT OR IGNORE INTO items
      (id, source_id, identity, title, url, locator, first_seen, state, author) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const update = db.prepare(`UPDATE items SET title = ?, url = coalesce(?, url), locator = ?, author = coalesce(?, author)
      WHERE id = ? AND state IN ('baseline', 'pending')`);
    // The desktop agent supplies items newest first. Insert oldest first for delivery.
    for (const item of [...items].reverse()) {
      const result = insert.run(item.id, source.id, item.identity, item.title, item.url, item.locator,
        now, baseline ? 'baseline' : 'pending', item.author);
      added += result.changes;
      if (!result.changes) update.run(item.title, item.url, item.locator, item.author, item.id);
    }
    return { baselined: baseline ? added : 0, queued: baseline ? 0 : added, observed: items.length };
  });
}

function plan(db, config, now) {
  const scan = db.prepare(`SELECT initialized_at, scanned_at, coverage, scan_note FROM sources WHERE id = ?`);
  const history = db.prepare(`SELECT identity, title, url, locator, first_seen
    FROM items WHERE source_id = ? ORDER BY rowid DESC LIMIT 40`);
  return {
    schedule: config.schedule,
    today: scheduleFor(config.schedule, now),
    delivery: config.delivery,
    sources: config.sources.map(source => ({
      ...source, lastScan: scan.get(source.id) ?? null, recentItems: history.all(source.id),
    })),
  };
}

function queue(db, config) {
  const pending = db.prepare(`SELECT i.*, s.name AS source_name, s.kind FROM items i
    JOIN sources s ON s.id = i.source_id WHERE i.state = 'pending' ORDER BY i.rowid`).all();
  const active = new Map(config.sources.map(source => [source.id, source]));
  return pending.filter(item => {
    const source = active.get(item.source_id);
    return source?.name === item.source_name && source.kind === item.kind;
  }).map(item => ({
    ...item, eligible: Boolean(item.url),
  }));
}

function finish(db, options, now) {
  const { attempt, result } = options;
  const note = clean(options.note);
  requireValue(attempt && note && ['sent', 'unsent'].includes(result),
    '填写 --attempt、--result sent|unsent 和描述证据的 --note。');
  return transaction(db, () => {
    const row = db.prepare(`SELECT item_id FROM attempts WHERE id = ? AND ended_at IS NULL`).get(attempt);
    requireValue(row, '找不到待核对的发送记录。');
    const state = result === 'sent' ? 'sent' : 'pending';
    db.prepare('UPDATE attempts SET ended_at = ?, result = ?, note = ? WHERE id = ?')
      .run(now, result, note, attempt);
    db.prepare('UPDATE items SET state = ? WHERE id = ?').run(state, row.item_id);
    return { itemId: row.item_id, state };
  });
}

function status(db) {
  return {
    ...digestStatus(db),
    scans: db.prepare('SELECT * FROM sources ORDER BY id').all(),
    totals: db.prepare('SELECT state, count(*) AS count FROM items GROUP BY state').all(),
    unresolved: db.prepare(`SELECT a.id AS attempt, a.item_id, a.started_at, a.route, i.title, i.locator
      FROM attempts a JOIN items i ON i.id = a.item_id WHERE a.ended_at IS NULL ORDER BY started_at`)
      .all().map(row => ({ ...row, route: JSON.parse(row.route) })),
  };
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') {
    console.log('用法: node wechat-rss.mjs <plan|ingest|queue|prepare|digest|claim-digest|finish-digest|status> [--config path] [--state dir]');
    return;
  }
  requireValue(Object.hasOwn(commands, command), '未知命令。');
  const names = [...commands[command], 'config', 'state'];
  const options = Object.fromEntries(names.map(name => [name, { type: name === 'refresh' ? 'boolean' : 'string' }]));
  const { values } = parseArgs({ args, options });
  const root = fileURLToPath(new URL('.', import.meta.url));
  const defaultConfig = resolve(root, 'config.json');
  const config = ['status', 'finish', 'finish-digest'].includes(command) ? null :
    readConfig(values.config ?? (existsSync(defaultConfig) ? defaultConfig : resolve(root, 'config.example.json')));
  requireValue(command !== 'ingest' || values.input, '用 --input 指定巡检结果 JSON 文件。');
  const input = command === 'ingest' ? readJson(values.input) : null;
  const db = openStore(values.state ?? resolve(root, 'state'));
  const now = new Date();
  try {
    let output;
    switch (command) {
      case 'plan': output = plan(db, config, now); break;
      case 'ingest': output = ingest(db, config, input, now.toISOString()); break;
      case 'queue': output = queue(db, config); break;
      case 'prepare': output = prepareDigest(db, config, values.round, now, () => queue(db, config), values.refresh); break;
      case 'digest': {
        const day = values.day ?? scheduleFor(config.schedule, now).day;
        requireValue(/^\d{8}$/u.test(day) && /^([01]\d|2[0-3]):[0-5]\d$/u.test(values.round ?? ''),
          '用 --round 指定推送轮次，可用 --day 指定 YYYYMMDD。');
        output = readDigest(db, day, values.round);
        break;
      }
      case 'claim-digest': output = claimDigest(db, config, values.round, now, randomUUID()); break;
      case 'finish-digest': output = finishDigest(db, values, now); break;
      case 'finish': output = finish(db, values, now.toISOString()); break;
      case 'status': output = status(db); break;
    }
    console.log(JSON.stringify(output, null, 2));
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
