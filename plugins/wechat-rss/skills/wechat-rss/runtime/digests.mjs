export function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function installDigests(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS digests (
      day TEXT NOT NULL, round TEXT NOT NULL, payload TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('prepared', 'sending', 'sent')),
      prepared_at TEXT NOT NULL, sent_at TEXT,
      PRIMARY KEY (day, round)
    );
    CREATE TABLE IF NOT EXISTS digest_attempts (
      id TEXT PRIMARY KEY, day TEXT NOT NULL, round TEXT NOT NULL, route TEXT NOT NULL,
      started_at TEXT NOT NULL, ended_at TEXT, result TEXT, note TEXT,
      FOREIGN KEY (day, round) REFERENCES digests(day, round)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_digest_attempt ON digest_attempts(day, round)
      WHERE ended_at IS NULL;
  `);
}

function minuteOf(time) {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

function timeOf(minutes) {
  return [Math.floor(minutes / 60), minutes % 60].map(value => String(value).padStart(2, '0')).join(':');
}

function label(time) {
  const [hour, minute] = time.split(':').map(Number);
  const suffix = minute === 0 ? '' : minute === 30 ? '半' : `${minute}分`;
  return `${hour % 12 || 12}点${suffix}`;
}

function localClock(timeZone, now) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const local = Object.fromEntries(formatter.formatToParts(now).map(({ type, value }) => [type, value]));
  const day = local.year + local.month + local.day;
  const time = `${local.hour}:${local.minute}`;
  return { day, time };
}

export function scheduleFor(schedule, now) {
  const { day, time } = localClock(schedule.timezone, now);
  const [first, late] = schedule.times;
  const rounds = schedule.times.map(round => ({
    time: round,
    prepareAt: timeOf(minuteOf(round) - schedule.leadMinutes),
    heading: `${day}-${round === late ? '晚间' : ''}${label(round)}推送`,
  }));
  return { day, time, first, late, rounds };
}

export function readDigest(db, day, round) {
  const row = db.prepare('SELECT * FROM digests WHERE day = ? AND round = ?').get(day, round);
  if (!row) return null;
  const payload = JSON.parse(row.payload);
  return {
    day, round, state: row.state, preparedAt: row.prepared_at, sentAt: row.sent_at,
    ...payload, message: renderDigest(payload),
  };
}

function oneLine(text) {
  return text.replace(/[\r\n\u2028\u2029]+/gu, ' ').trim();
}

function renderSection(items, requiredStatuses = []) {
  const blocks = items.map(item => `${oneLine(item.title)}\n作者：${oneLine(item.author)}\n${item.url}`);
  if (requiredStatuses.length) {
    const lines = requiredStatuses.map(({ name, status }) => `${oneLine(name)}：${status}`);
    blocks.push(['必看账号', ...lines].join('\n'));
  }
  return blocks.join('\n\n') || '无更新';
}

function renderDigest({ heading, newItems, requiredStatuses, earlierItems, earlierHeading, earlierAvailable, earlierRequiredStatuses }) {
  if (earlierItems === null) return `${heading}\n\n${renderSection(newItems, requiredStatuses)}`;
  const earlier = earlierAvailable ? renderSection(earlierItems, earlierRequiredStatuses) : '未生成该轮记录';
  return `${heading}\n\n新增\n\n${renderSection(newItems)}\n\n${earlierHeading}\n\n${earlier}`;
}

function scanStatus(source, scan, timing) {
  if (!scan?.scanned_at || scan.kind !== source.kind || scan.name !== source.name) return '待确认，尚未巡检';
  const lastCheck = localClock(timing.timezone, new Date(scan.scanned_at));
  if (lastCheck.day !== timing.day || lastCheck.time < timing.prepareAt) return '待确认，本轮尚未巡检';
  if (scan.coverage !== 'complete') return '待确认，本轮巡检未完成';
  if (!scan.initialized_at || scan.initialized_at === scan.scanned_at) return '本轮已建立基线';
  return '本轮未更新';
}

function requiredStatus(sources, getScan, pending, timing) {
  if (pending.some(item => !item.url)) return '有更新，链接待确认';
  if (pending.length) return '有更新，投递记录待核对';
  const statuses = sources.map(source => scanStatus(source, getScan.get(source.id), timing));
  return statuses.find(status => status.startsWith('待确认')) ??
    statuses.find(status => status === '本轮已建立基线') ?? '本轮未更新';
}

function catchUpDay(day, today, round) {
  if (day === undefined) return today.day;
  if (!/^\d{8}$/u.test(day) || day >= today.day || round !== today.late) {
    throw new Error('跨日补发须指定过去的日期 YYYYMMDD 和晚间轮次。');
  }
  return day;
}

export function prepareDigest(db, config, round, now, pendingItems, refresh = false, day) {
  const { schedule, sources } = config;
  const today = scheduleFor(schedule, now);
  const digestDay = catchUpDay(day, today, round);
  const catchUp = digestDay !== today.day;
  const target = today.rounds.find(candidate => candidate.time === round);
  if (!target) throw new Error('指定配置中的推送轮次。');
  return transaction(db, () => {
    const existing = readDigest(db, digestDay, round);
    if (catchUp && !existing) throw new Error('找不到该日待补发的晚间汇总。');
    if (existing && !refresh) return existing;
    if (existing && (existing.state !== 'prepared' || (!catchUp && today.time >= round))) {
      throw new Error('只能刷新待发送汇总。当天的汇总须在推送前刷新。');
    }
    const nextPrep = today.rounds[1].prepareAt;
    if (!catchUp && (today.time < target.prepareAt || (round === today.first && today.time >= nextPrep))) {
      throw new Error('当前不在该轮的准备时段。');
    }

    const earlier = round === today.late ? readDigest(db, digestDay, today.first) : null;
    const withheld = new Set(earlier?.newItems.map(item => item.id));
    const unconfirmed = db.prepare("SELECT payload FROM digests WHERE state = 'sending'").all();
    for (const row of unconfirmed) {
      const { newItems, earlierItems } = JSON.parse(row.payload);
      for (const item of [...newItems, ...(earlierItems ?? [])]) withheld.add(item.id);
    }

    const pending = pendingItems();
    const deliverable = pending.filter(item => item.url && !withheld.has(item.id));
    const newItems = deliverable
      .map(item => ({ id: item.id, title: item.title, author: item.author || item.source_name, url: item.url }));
    const requiredStatuses = [];
    if (round === today.first) {
      const timing = { timezone: schedule.timezone, day: today.day, prepareAt: target.prepareAt };
      const includedSources = new Set(deliverable.map(item => item.source_id));
      const getScan = db.prepare('SELECT * FROM sources WHERE id = ?');
      const requiredNames = new Set(sources.filter(source => source.required).map(source => source.name));
      for (const name of requiredNames) {
        const accountSources = sources.filter(source => source.name === name);
        if (accountSources.some(source => includedSources.has(source.id))) continue;
        const accountIds = new Set(accountSources.map(source => source.id));
        const accountPending = pending.filter(item => accountIds.has(item.source_id));
        requiredStatuses.push({ name, status: requiredStatus(accountSources, getScan, accountPending, timing) });
      }
    }
    const payload = {
      heading: catchUp ? existing.heading : target.heading,
      newItems,
      requiredStatuses,
      earlierHeading: catchUp ? existing.earlierHeading : round === today.late ? today.rounds[0].heading : null,
      earlierAvailable: Boolean(earlier),
      earlierItems: round === today.late ? earlier?.newItems ?? [] : null,
      earlierRequiredStatuses: earlier?.requiredStatuses ?? [],
    };
    db.prepare(`INSERT INTO digests (day, round, payload, state, prepared_at) VALUES (?, ?, ?, 'prepared', ?)
      ON CONFLICT(day, round) DO UPDATE SET payload = excluded.payload, prepared_at = excluded.prepared_at`)
      .run(digestDay, round, JSON.stringify(payload), now.toISOString());
    return readDigest(db, digestDay, round);
  });
}

export function claimDigest(db, config, round, now, attempt, day) {
  if (!config.delivery.enabled) throw new Error('发送开关未启用。');
  const today = scheduleFor(config.schedule, now);
  const digestDay = catchUpDay(day, today, round);
  if (!config.schedule.times.includes(round)) throw new Error('指定配置中的推送轮次。');
  if (digestDay === today.day && (today.time < round || (round === today.first && today.time >= today.late))) {
    throw new Error('当前不在该轮的投递时段。');
  }
  return transaction(db, () => {
    const digest = readDigest(db, digestDay, round);
    if (digest?.state !== 'prepared') throw new Error('本轮没有可领取的待发送汇总。');
    db.prepare('INSERT INTO digest_attempts (id, day, round, route, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(attempt, digestDay, round, JSON.stringify(config.delivery), now.toISOString());
    db.prepare("UPDATE digests SET state = 'sending' WHERE day = ? AND round = ?").run(digestDay, round);
    return { ...digest, state: 'sending', attempt, route: config.delivery };
  });
}

export function finishDigest(db, { attempt, result, note }, now) {
  if (!attempt || !note?.trim() || !['sent', 'unsent'].includes(result)) {
    throw new Error('填写 --attempt、--result sent|unsent 和说明依据的 --note。');
  }
  return transaction(db, () => {
    const row = db.prepare('SELECT day, round FROM digest_attempts WHERE id = ? AND ended_at IS NULL').get(attempt);
    if (!row) throw new Error('找不到待核对的汇总发送记录。');
    const { day, round } = row;
    const sent = result === 'sent';
    const timestamp = now.toISOString();
    const state = sent ? 'sent' : 'prepared';
    db.prepare('UPDATE digest_attempts SET ended_at = ?, result = ?, note = ? WHERE id = ?')
      .run(timestamp, result, note.trim(), attempt);
    db.prepare('UPDATE digests SET state = ?, sent_at = ? WHERE day = ? AND round = ?')
      .run(state, sent ? timestamp : null, day, round);
    if (sent) {
      const digest = readDigest(db, day, round);
      const update = db.prepare("UPDATE items SET state = 'sent' WHERE id = ? AND state = 'pending'");
      for (const item of [...digest.newItems, ...(digest.earlierItems ?? [])]) update.run(item.id);
    }
    return { day, round, state };
  });
}

export function digestStatus(db) {
  return {
    recentDigests: db.prepare('SELECT day, round, state, prepared_at, sent_at FROM digests ORDER BY day DESC, round DESC LIMIT 16').all(),
    unresolvedDigests: db.prepare('SELECT id AS attempt, day, round, route, started_at FROM digest_attempts WHERE ended_at IS NULL')
      .all().map(row => ({ ...row, route: JSON.parse(row.route) })),
  };
}
