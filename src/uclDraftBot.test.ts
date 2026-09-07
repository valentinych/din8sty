import test from "node:test";
import assert from "node:assert/strict";

import {
  dueUclDeadlineOffsets,
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

test("пинг не обещает обратный отсчёт ни одной из случайных фраз", () => {
  // В драфте ЛЧ нет таймера и автопика — копия не должна их подразумевать.
  const forbidden = /автопик|таймер|время тикает|банк времени|не проспи|успей/i;

  for (let i = 0; i < 500; i++) {
    assert.doesNotMatch(formatUclPingMessage({ teamName: "Тест" }), forbidden);
  }
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
