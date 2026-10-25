# Один Render-сервис: web + Telegram, v0.3.4 build 12

Тот же репозиторий `agentstroy555/prorab_talk`, тот же Render Web Service, тот же URL, одна команда `npm start`, один Node.js процесс, один HTTP listener на `PORT`. Telegram включается через `TELEGRAM_ENABLED=true`. При false (default) работает только прежний web; токен/диск не требуются.

Web UX и его VAD остаются прежними; изменены только metadata версии и запуск сервера. Telegram использует общий каталог/parser/matcher, но собственную консервативную обёртку и splitter. Один voice может создавать несколько строк за один STT-запрос. Web-заявки остаются в существующем PostgreSQL, Telegram-черновики/очередь/ledger — в SQLite. Это общий хостинг, а не синхронизация смет между каналами.

Доступ открыт любому человеку в личном чате. Настройка пользовательских ID не нужна; Telegram передаёт ID автоматически для разделения смет. Устаревшая переменная ALLOWED_USER_IDS игнорируется, её можно удалить.

## Настройки существующего сервиса

Новый сервис и новая база Postgres не нужны. Не удалять/не пересоздавать текущую базу, не менять её DATABASE_URL/PGSSL. Сохранить существующий GROQ_API_KEY: он используется обоими каналами.

1. Runtime — Node; `NODE_VERSION=24.22.1`. Root directory — корень репозитория.
2. Build command: `npm ci && npm run check && npm test`. Start command: `npm start`.
3. Health check: `/api/health`. Он проверяет PostgreSQL и готовность Telegram runtime, если бот включён. `/health` — тот же combined health.
4. Для включённого бота нужен платный постоянно работающий instance + Persistent Disk на `/var/data` (например, 1 GB); одна реплика. Код не покупает ресурсы. Старый `render.yaml` сохраняет free web baseline без бота; не использовать его повторную синхронизацию как конфигурацию включённого бота. Настройки ниже применяются к существующему сервису вручную.
5. В Environment добавить:

```dotenv
NODE_VERSION=24.22.1
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=ТОКЕН_ИЗ_ПРИВАТНОГО_ФАЙЛА
BOT_MODE=polling
DB_PATH=/var/data/agent-stroy.sqlite
```

`PORT` задаёт Render; не переопределять. `GROQ_API_KEY` и `DATABASE_URL` уже должны быть заполнены у web. Пустой токен/key при включённом боте закрывает запуск. `DB_PATH` должен быть абсолютным, на подключённом постоянном диске; абсолютный путь сам по себе не создаёт Render Disk.

Токен сохранён владельцем на приватном Google Drive; в публичный GitHub его не помещаем. Старый приватный build 10 с встроенным токеном остаётся архивом, не источником для public push. Не запускать второй bot polling process/отдельный Telegram `npm start` рядом с общим сервисом.

## Polling или webhook

Polling проще для первого запуска. Входящие HTTP Telegram не требуются. Но при активном webhook запуск polling завершится ошибкой: сервис только читает getWebhookInfo, автоматически webhook не удаляет.

Webhook поддерживается на том же URL: `https://ВАШ_СУЩЕСТВУЮЩИЙ_ХОСТ/telegram/webhook`. Для него задать BOT_MODE=webhook и WEBHOOK_SECRET (случайные 24–256 символов A–Z/a–z/0–9/_/-), отдельно зарегистрировать setWebhook с тем же secret_token, allowed_updates=[message,callback_query], max_connections=1. Маршрут получает исходный HTTP body до Express JSON middleware; проверяет секрет и durable enqueue. Регистрация webhook в коде не выполняется.

## Проверка после деплоя

- `/` открывает существующий интерфейс; version badge v0.3.4 (build 12).
- `/api/health` → 200, ok=true, telegram.enabled=true, telegram.ready=true.
- В логах `service.ready` с version 0.3.4, build 12, web=true и telegram=polling/webhook.
- `/start` → `/new Тест` → текстовый список → один voice с несколькими позициями → reply-уточнение → `/finish` → CSV/JSON.
- Перезапустить сервис: `/history` сохраняется, web API сохранения работает. Проверить реальный счётчик Groq.

При ошибке Telegram config сайт сохраняет прежнюю работоспособность после установки TELEGRAM_ENABLED=false и redeploy. Это отключает worker, не удаляет SQLite. Для отката версии использовать прошлый commit с совместимой БД; не удалять диск.

## Проверки и ограничения

Из корня: `npm ci`, `npm run check`, `npm test`, `npm run demo:telegram`. Автотесты: прежние web regressions, Telegram tests с настоящей SQLite, HTTP integration shared listener/webhook/polling и startup/shutdown. Telegram/Groq заменены mock adapters; настоящая речь и Render acceptance не доказаны этими тестами.

SQLite требует постоянного диска независимо от транспорта. Free Render service засыпает и теряет эфемерные файлы при restart/deploy. Если нужно обойтись без диска, следующая отдельная задача — портирование Telegram store в PostgreSQL. Текущий synchronous SQLite Store нельзя корректно переключить одной переменной DATABASE_URL.

Квоты Telegram сохраняются в его ledger. Прежний web /api/transcribe использует тот же Groq key, но не учитывается в Telegram ledger; суммарный лимит аккаунта остаётся общим. Этот релиз не добавляет общий межканальный бюджет/аутентификацию web API. Не утверждать, что лимиты бота защищают аккаунт от всех web-запросов.

SIGTERM останавливает приём/worker и отменяет внешние запросы Telegram/Groq; неизвестный результат STT/send не повторяется автоматически. Если процесс принудительно уничтожен, применяется сохранённый recovery ledger. Один SQLite lease ограничивает запуск с одним диском; платформа должна обеспечивать одну реплику.

Backup: `DB_PATH=/var/data/agent-stroy.sqlite npm --prefix telegram run backup` создаёт согласованный snapshot в telegram/var/backups (эфемерный путь). Немедленно копировать snapshot за пределы контейнера; автоматический внешний backup этим релизом не настраивается. Не копировать только live .sqlite без WAL/backup.

Официальные документы, проверены 2026-10-25:
https://render.com/docs/disks
https://render.com/docs/free
https://render.com/docs/node-version
