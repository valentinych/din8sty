import test from "node:test";
import assert from "node:assert/strict";

import Database from "better-sqlite3";

import {
  dueUclDeadlineOffsets,
  ensureUclBotTables,
  formatUclPickDigest,
  formatUclPickLog,
  formatUclPingMessage,
} from "./uclDraftBot.js";

/** MD1 в проде: 8 сентября 2026, 16:45 UTC (18:45 CEST). */
const MD1 = Date.parse("2026-09-08T16:45:00.000Z");
const MIN = 60_000;

test("напоминание срабатывает, только когда окно уже наступило", () => {
  const minutes = [1440, 60, 15];

  // За двое суток не должно уйти ничего.
  assert.deepEqual(
    dueUclDeadlineOffsets({
      minutes,
      alreadySent: [],
      deadlineMs: MD1,
      nowMs: MD1 - 2880 * MIN,
    }),
    [],
  );

  // Ровно на отметке 1440 мин — первое напоминание.
  assert.deepEqual(
    dueUclDeadlineOffsets({
      minutes,
      alreadySent: [],
      deadlineMs: MD1,
      nowMs: MD1 - 1440 * MIN,
    }),
    [1440],
  );

  // Через сутки просрочки подтягиваются все, от дальнего к ближнему.
  assert.deepEqual(
    dueUclDeadlineOffsets({
      minutes,
      alreadySent: [],
      deadlineMs: MD1,
      nowMs: MD1 - 10 * MIN,
    }),
    [1440, 60, 15],
  );
});

test("одно и то же напоминание не уходит дважды", () => {
  assert.deepEqual(
    dueUclDeadlineOffsets({
      minutes: [1440, 60],
      alreadySent: [1440],
      deadlineMs: MD1,
      nowMs: MD1 - 30 * MIN,
    }),
    [60],
  );
});

test("после первого свистка напоминаний нет", () => {
  assert.deepEqual(
    dueUclDeadlineOffsets({
      minutes: [1440, 60],
      alreadySent: [],
      deadlineMs: MD1,
      nowMs: MD1,
    }),
    [],
  );
  assert.deepEqual(
    dueUclDeadlineOffsets({
      minutes: [60],
      alreadySent: [],
      deadlineMs: Number.NaN,
      nowMs: MD1,
    }),
    [],
  );
});

test("мусор в настройках игнорируется", () => {
  assert.deepEqual(
    dueUclDeadlineOffsets({
      minutes: [0, -5, 60, 1.5],
      alreadySent: [],
      deadlineMs: MD1,
      nowMs: MD1 - 5 * MIN,
    }),
    [60],
  );
});

test("пинг хода называет слот и раунд", () => {
  const text = formatUclPingMessage({
    teamName: "Тест",
    pickNo: 7,
    round: 1,
    redeeming: true,
    picksLeft: 2,
  });
  assert.match(text, /Твоя очередь в драфте Лиги чемпионов — «Тест»/);
  assert.match(text, /Пик #7 · раунд 1 · отложенный слот/);
  assert.match(text, /Подряд твоих пиков: 2/);
});

test("пока часы не взведены, пинг не обещает обратный отсчёт", () => {
  const forbidden = /автопик|мин на пик|часы идут|Банк/i;

  for (let i = 0; i < 200; i++) {
    // Ни без часов вовсе, ни с невзведёнными.
    assert.doesNotMatch(formatUclPingMessage({ teamName: "Тест" }), forbidden);
    assert.doesNotMatch(
      formatUclPingMessage({
        teamName: "Тест",
        clock: {
          armed: false,
          timeoutSec: 1800,
          remainingSec: 1800,
          bankRemainingSec: 14400,
          bankExhausted: false,
        },
      }),
      forbidden,
    );
  }
});

test("взведённые часы попадают в пинг вместе с последствиями просрочки", () => {
  const text = formatUclPingMessage({
    teamName: "Тест",
    pickNo: 9,
    round: 2,
    clock: {
      armed: true,
      timeoutSec: 1800,
      remainingSec: 1680,
      bankRemainingSec: 14400,
      bankExhausted: false,
    },
  });
  assert.match(text, /⏱ 28 мин на пик \(часы идут 10:00–20:00, Варшава\)/);
  assert.match(text, /Не успеешь — автопик: первый подходящий из вишлиста/);
  assert.match(text, /Банк: 4 ч/);
  assert.doesNotMatch(text, /Банк на нуле/);
});

test("исчерпанный банк меняет предупреждение на автопилот до конца драфта", () => {
  const text = formatUclPingMessage({
    teamName: "Тест",
    clock: {
      armed: true,
      timeoutSec: 600,
      remainingSec: 540,
      bankRemainingSec: 600,
      bankExhausted: true,
    },
  });
  assert.match(text, /⏱ 9 мин на пик/);
  assert.match(text, /⚠️ Банк на нуле — после просрочки уйдёшь в автопик/);
  assert.doesNotMatch(text, /^Банк: /m);
});

function pick(n: number, team: string, player: string | null, club = "RMA") {
  return {
    id: n,
    pickNumber: n,
    round: 1,
    skipped: player === null,
    auto: false,
    teamName: team,
    email: `${team}@x.c`,
    playerName: player,
    position: player === null ? null : "FWD",
    clubShort: player === null ? null : club,
    clubName: null,
  };
}

test("догоняющий дайджест — одно сообщение в порядке пиков", () => {
  const msgs = formatUclPickDigest({
    title: "📋 Пики до подключения бота",
    lead: "Лог включён с пика #4 — вот что было раньше.",
    // Намеренно вперемешку: порядок задаёт номер пика, а не список.
    picks: [pick(3, "C", "Кварацхелия", "PSG"), pick(1, "A", "Мбаппе"), pick(2, "B", null)],
    tail: "https://example.test",
  });

  assert.equal(msgs.length, 1, "шесть пиков не должны стать шестью постами");
  assert.equal(
    msgs[0],
    [
      "📋 Пики до подключения бота",
      "Лог включён с пика #4 — вот что было раньше.",
      "",
      "1. «A» — Мбаппе · FWD · RMA",
      "2. «B» — ⏭ пропуск слота",
      "3. «C» — Кварацхелия · FWD · PSG",
      "",
      "https://example.test",
    ].join("\n"),
  );
});

test("длинная история режется на части с нумерацией", () => {
  const many = Array.from({ length: 120 }, (_, i) => pick(i + 1, "T", "Игрок"));
  const msgs = formatUclPickDigest({ title: "📋 Пропущенные пики", picks: many });

  assert.equal(msgs.length, 3);
  assert.match(msgs[0]!, /^📋 Пропущенные пики \(1\/3\)/);
  assert.match(msgs[2]!, /^📋 Пропущенные пики \(3\/3\)/);
  assert.equal(formatUclPickDigest({ title: "x", picks: [] }).length, 0);
});

test("бэкфилл истории не повторяется после перезапуска бота", () => {
  const db = new Database(":memory:");
  ensureUclBotTables(db);

  // Состояние, как его засеял первый запуск: лог начат с пика #7.
  db.prepare(
    `INSERT INTO ucl_bot_state (id, last_logged_pick_id, backfill_before_id)
     VALUES (1, 6, 6)`,
  ).run();

  const read = () =>
    db.prepare(`SELECT backfill_before_id AS b FROM ucl_bot_state WHERE id = 1`).get() as {
      b: number;
    };

  assert.equal(read().b, 6, "до отправки порог хранится в состоянии");

  // Так его гасит успешная отправка дайджеста.
  db.prepare(`UPDATE ucl_bot_state SET backfill_before_id = 0 WHERE id = 1`).run();
  assert.equal(read().b, 0);

  // Перезапуск: ensureUclBotTables повторяется, курсор живой строки не трогает.
  ensureUclBotTables(db);
  assert.equal(read().b, 0, "перезапуск не должен заново поднимать бэкфилл");

  // И курсор пиков перезапуск тоже не откатывает.
  const cursor = db
    .prepare(`SELECT last_logged_pick_id AS c FROM ucl_bot_state WHERE id = 1`)
    .get() as { c: number };
  assert.equal(cursor.c, 6);
  db.close();
});

test("миграция на существующей строке не включает бэкфилл задним числом", () => {
  const db = new Database(":memory:");
  // Таблица в том виде, в каком она уехала первым деплоем — без колонки.
  db.exec(`
    CREATE TABLE ucl_bot_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_logged_pick_id INTEGER NOT NULL DEFAULT 0,
      last_logged_action_id INTEGER NOT NULL DEFAULT 0,
      last_logged_window_id TEXT NOT NULL DEFAULT '',
      announced_status TEXT NOT NULL DEFAULT '',
      announced_deadline_matchday INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO ucl_bot_state (id, last_logged_pick_id) VALUES (1, 12);
  `);

  ensureUclBotTables(db);

  const row = db
    .prepare(`SELECT last_logged_pick_id AS c, backfill_before_id AS b
              FROM ucl_bot_state WHERE id = 1`)
    .get() as { c: number; b: number };
  // 12 пиков уже в топике — молчание, а не дубль всей истории.
  assert.equal(row.b, 0);
  assert.equal(row.c, 12);
  db.close();
});

test("пропуск в логе не выдаётся за пик", () => {
  const skip = formatUclPickLog({
    id: 3,
    pickNumber: 5,
    round: 1,
    skipped: true,
    auto: false,
    teamName: "Тест",
    email: "a@b.c",
    playerName: null,
    position: null,
    clubShort: null,
    clubName: null,
  });
  assert.match(skip, /⏭ Пропуск · пик #5 · раунд 1/);
  assert.doesNotMatch(skip, /выбирает/);

  const pick = formatUclPickLog(
    {
      id: 4,
      pickNumber: 6,
      round: 1,
      skipped: false,
      auto: false,
      teamName: "Тест & Ко",
      email: "a@b.c",
      playerName: "Мбаппе",
      position: "FWD",
      clubShort: "RMA",
      clubName: "Real Madrid",
    },
    "Следующий: «Другая»",
  );
  // HTML-топик: амперсанд в названии команды обязан быть экранирован.
  assert.match(pick, /«Тест &amp; Ко» выбирает:/);
  assert.match(pick, /Мбаппе · FWD · RMA/);
  assert.match(pick, /Следующий: «Другая»/);
});
