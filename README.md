# Din8sty

Fantasy-футбол по восьми сильнейшим чемпионатам УЕФА: база игроков, лайв-драфт **Топ-4 катки**, составы на игровые недели и подсчёт FPTS.

**Сайт:** [din8sty.panenka.games](https://din8sty.panenka.games/)

Вход через Google SSO на [panenka.games](https://panenka.games). Интерфейс на русском, украинском, белорусском и английском.

## Что это

Din8sty — приложение лиги, а не конструктор «под любой набор правил». На одной SQLite-базе живут:

1. **Каталог футболистов** топ-8 лиг (клуб, позиция TM, FM Rating, зарплата, стоимость, доступность, история клубов).
2. **Топ-4 катка** — основная fantasy-лига сезона 2026/27: 9 менеджеров, snake-драфт 26 раундов, составы на каждый GW, автозамены, трансферы, live standing.
3. **Пример / Топ-8 / Топ-26** — черновики и эмуляции (небесные команды Примера, пулы топ-8 и топ-26 по FM Rating).
4. **Расписание** матчей с логотипами турниров и статусами API-Football.

Продакшен крутится на том же Hetzner-хосте, что и panenka.games (`panenka-prod`), за Caddy: `https://din8sty.panenka.games`.

## Лиги

Пул игроков — домашние лиги с лучшим клубным рейтингом УЕФА:

| Код TM | Страна | Лига |
|--------|--------|------|
| GB1 | Англия | Premier League |
| ES1 | Испания | LaLiga |
| IT1 | Италия | Serie A |
| L1 | Германия | Bundesliga |
| FR1 | Франция | Ligue 1 |
| PO1 | Португалия | Liga Portugal |
| BE1 | Бельгия | Jupiler Pro League |
| NL1 | Нидерланды | Eredivisie |

**Топ-4 катка** использует только ENG / SPA / ITA / GER. Остальные четыре лиги нужны каталогу, Примеру и Топ-8.

## Топ-4 катка

Сезонные рамки (код: `src/top4League.ts`, `src/gameweeks.ts`, `src/primerLineups.ts`):

| Параметр | Значение |
|----------|----------|
| Команд | 9 |
| Раундов драфта | 26 (минимум 26 игроков в ростере, ≥3 GK) |
| Потолок MV | €1.2B |
| Потолок wage | €5M / неделю |
| Квота лиг | ≥3 игрока из каждой из ENG / SPA / ITA / GER |
| Квота клуба | ≤3 игрока из одного клуба |
| Часы драфта | 10:00–20:00 Europe/Warsaw (админ может сузить окно) |
| Таймаут пика | 30 минут + банк 4 часа на менеджера |
| GW | пятница 00:00 Europe/London → четверг; GW1 = 7 августа 2026 |

### Драфт

Snake-драфт по живой очереди. На пик 30 минут внутри часов драфта; неиспользованное время уходит в банк. Таймаут с остатком банка → пик с wishlist, иначе алгоритм. Исчерпание банка → out of draft и автопик.

**Consigliere** — доверенный участник той же лиги: может заполнить пустой wishlist и выставить состав до дедлайна, если менеджер ещё ничего не сохранил. Выбор менеджера consigliere переписать не может.

### Составы на GW

Страница [Выставить состав](https://din8sty.panenka.games/lineup.html?league=top4): формация + XI + лавка (1 GK + 6 полевых).

Доступные схемы: `4-4-2 / 4-2-4`, `4-5-1 / 4-3-3`, `3-5-2 / 5-3-2`, `3-4-3 / 5-2-3`, `5-4-1`. Слот принимает игрока только если роли Transfermarkt пересекаются с ролями слота. На слоте назначается конкретная роль; **+20% FPTS**, если она совпадает с основной (`detail_role`).

Дедлайн тура — пятница 00:00 London (старт GW). Менеджер после этого всё ещё может менять игроков, чьи клубы ещё не сыграли в туре. Чужие составы открываются после старта GW.

**Дефолт селектора GW:** пт–вс London — текущий тур; с понедельника — следующий. Так пятничный сейв до вечерних матчей попадает в неделю, которая уже началась, а не в «next».

Если стартер не сыграл (0 минут, у клуба больше нет матчей GW, статистика подтянута), на слот выходит запасной: сначала по основной роли, затем по дополнительным, внутри шага — порядок лавки. Запасной с уже подтверждённым DNP пропускается.

### Очки (FPTS)

Сырые очки — та же шкала, что в Примере (`src/primerLineups.ts`): выход, гол, ассист, CS, пропущенные, сейвы, карточки; линия GKP / DEF / MID / FWD. Несколько матчей клуба в одном GW суммируются. Затем множитель турнира:

| Турнир | × |
|--------|---|
| Чемпионат | 2.0 |
| Лига чемпионов | 1.5 |
| Лига Европы | 1.0 |
| Лига конференций | 0.7 |
| Национальный кубок | 0.5 |
| Кубок лиги | 0.4 |
| Суперкубок | 0.3 |

Плюс ×1.2 за идеальную позицию в XI / автозамене.

### Трансферы

Четыре окна: после GW4, GW15, GW26, GW37. До 5 ходов (сброс или пик за бюджет, не оба в одном ходе). Очередь с последнего места таблицы. Выкинутый из будущих составов игрок снимается со слотов, строка XI не удаляется.

## Страницы

| URL | Содержание |
|-----|------------|
| `/` | Каталог футболистов, фильтры по лиге / клубу / линии / позиции |
| `/player.html?id=` | Карточка игрока: рейтинг, wage, клубы, матчи, FPTS |
| `/schedule.html` | Расписание топ-8 + еврокубки |
| `/top4.html` | Лига: драфт, составы, статистика, live standing, результаты, трансферы, GWs, правила |
| `/lineup.html?league=top4` | Редактор XI на GW |
| `/squad.html` | «Мой состав»: очки по турам, «принёс» / «набрал» |
| `/admin.html` | Админ: маппинг команд Примера, ручные правки |
| `/admin-fm.html` | Ручной матч FMInside |

## Стек

- **Runtime:** Node 22, TypeScript (`tsx`, без отдельного build step в проде)
- **HTTP:** Fastify 5, статика из `public/`
- **БД:** SQLite через `better-sqlite3` (`data/din8sty.db`, в Docker — bind-mount `/app/data`)
- **Фронт:** ванильный JS + CSS, PWA (`manifest.webmanifest`, service worker)
- **Продакшен:** Docker Compose + Caddy на сети `panenkagames_default`
- **Данные:** Transfermarkt (игроки/клубы), FMInside (rating + wage), Capology (зарплаты), API-Football (матчи, события, статы)

Секреты в `.env` / `/opt/din8sty/.env.bot`, в git не попадают. На деплое `SSO_SECRET` копируется из `AUTH_SECRET` panenka.

## Локальный запуск

Нужны Node 22+, npm и (для FM-скрейпа) Python 3 + Playwright/Chrome.

```bash
cp .env.example .env          # SSO_SECRET / токены ботов по необходимости
npm install
npm run db:build              # игроки из соседнего TM app.db → data/din8sty.db
npm run fm:scrape             # FMInside Full Squad
npm run fm:match
npm run fixtures:sync         # API-Football, нужен ключ в окружении
npm run dev                   # http://127.0.0.1:3080
```

Чтобы ходить как на проде:

```bash
sudo sh -c 'grep -q din8sty.panenka.games /etc/hosts || echo "127.0.0.1 din8sty.panenka.games" >> /etc/hosts'
open http://din8sty.panenka.games:3080
```

Без Google SSO локально большинство топ-4 эндпоинтов вернёт `401`.

## Переменные окружения

См. `.env.example`. Главное:

| Переменная | Зачем |
|------------|--------|
| `SSO_SECRET` / `AUTH_SECRET` | Подпись сессии и SSO-handoff с panenka |
| `DIN8STY_DB` | Путь к SQLite (прод: `/app/data/din8sty.db`) |
| `PANENKA_ORIGIN` | `https://panenka.games` |
| `TOP4_PING_BOT_TOKEN` | Telegram-бот `/pihajme` |
| `H2H_BOT_SECRET` | Общий секрет с panenka для H2H-черновика |

Прод: токены ботов держать в `/opt/din8sty/.env.bot` — `deploy.sh` дописывает файл к `.env` и не затирает SSO.

## Скрипты

| Команда | Что делает |
|---------|------------|
| `npm run dev` / `start` | Fastify на порту 3080 |
| `npm run db:build` | Собрать игроков из Transfermarkt top-8 |
| `npm run fm:scrape` | Скачать Rating + wage с FMInside |
| `npm run fm:match` | Сопоставить FMInside → игроки TM |
| `npm run capology:sync` | Зарплаты Capology |
| `npm run fixtures:sync` | Матчи API-Football |
| `npm run fixtures:gameweeks` | Проставить GW по пятницам London |
| `npm run transfers:sync` | История клубов (TM). `--player ID` или `--all` |
| `npm run coaches:sync` | Тренеры |
| `npm run top4:gw:sync` | Статы игроков текущего GW |
| `npm run top4:season:sync` / `top8:season:sync` | Сезонная эмуляция FPTS |
| `npm run top4:ping-bot` | Telegram: Топ-4, FPL, H2H, UCL |
| `./scripts/deploy.sh` | rsync кода на `panenka-prod` (БД не трогает) |

## Продакшен

- Каталог на сервере: `/opt/din8sty`
- Контейнеры: `din8sty` (приложение) и `din8sty-top4-ping-bot`
- SQLite на хосте, volume `./data:/app/data`. **Деплой никогда не копирует `data/*.db*`.** Регистрации, live-драфт, составы и маппинги переживают rebuild.
- `ensureTop4Tables` создаёт недостающую схему и **не** сбрасывает драфт. Не вызывать `startLiveDraft` / `POST /api/top4/draft/start` из деплоя.
- `deploy.sh` перед рестартом снимает снапшот БД и сверяет `status` / `current_pick_no` / `current_pick_at` / число пиков.

```bash
./scripts/deploy.sh
```

Админ: `aharodnik@gmail.com`. Команды Примера задаются в `/admin.html` (`user_team_map`). Топ-4 регистрируется на странице лиги — маппинг Примера для этого не нужен.

## Telegram-боты

Один процесс `top4-ping-bot` (`src/top4PingBot.ts` и соседние `*DraftBot.ts`):

- **Топ-4:** пинг хода, лог пиков, `/pihajme`, `/deadline`
- **FPL:** лог пиков, DM на ход, привязка email `/fpl`
- **H2H (Пекло):** `/h2h`, уведомления о ходе и пиках соперника
- **UCL / UNL:** отдельные драфт-потоки в том же боте

## Структура репозитория

```
src/                 API, драфт, GW, FPTS, SSO, боты
public/              HTML/CSS/JS страниц и иконки PWA
scripts/             сборка БД, синки TM/AF/FM, deploy.sh
data/                SQLite и кэши (в git не коммитятся)
docker-compose.yml   din8sty + ping-bot
```

Корень `src/server.ts` — точка входа Fastify. Игровые недели: `src/gameweeks.ts`. Автозамены и результаты GW: `src/top4GwResults.ts`. Редактор состава: `public/lineup.js` + `PUT /api/lineup`.
