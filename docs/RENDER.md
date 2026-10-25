# Render Free + Neon: web и Telegram, v0.3.7 build 15

Один существующий Render Web Service, один HTTP-порт, одна команда `npm start`.
Платный instance и persistent disk не требуются. `DATABASE_URL` указывает на уже
настроенную Neon PostgreSQL. Веб-таблицы остаются в public, бот создаёт свои
таблицы в схеме telegram. Каталог/parser общие; сметы каналов не синхронизируются.

## Что требуется в существующем Web Service

- Node 24.x (закреплён в .node-version и package.json).
- DATABASE_URL — строка Neon с pooling и параметрами TLS.
- GROQ_API_KEY — существующий ключ распознавания.
- Токен бота встроен по прямому указанию владельца; TELEGRAM_BOT_TOKEN — только необязательная замена.
- Build: npm ci. Start: npm start. Health: /api/health.

На Render бот включается автоматически со встроенным токеном, даже при старом
TELEGRAM_ENABLED=false. Добавлять Telegram-переменные вручную не требуется.
Для локального web-only запуска TELEGRAM_ENABLED=false сохраняется.
На Render код автоматически выбирает webhook, получает адрес сервиса из
RENDER_EXTERNAL_URL и вызывает setWebhook с секретным заголовком, max_connections=1,
allowed_updates=[message,callback_query], drop_pending_updates=false. Секрет
производится из токена и стабилен между перезапусками; WEBHOOK_SECRET можно
переопределить. Регистрация выполняется после открытия HTTP listener.

Старые BOT_MODE=polling и DB_PATH=/var/data/... на Render больше не используются:
режим принудительно webhook, хранилище PostgreSQL. Эти переменные можно удалить,
но для перехода это не требуется. Диск не создаётся, ресурсы не покупаются.

Сохранить текущие DATABASE_URL/PGSSL/GROQ_API_KEY. Старую Render PostgreSQL не
восстанавливать: владелец разрешил отказаться от её тестовых данных. Каталог
веб-сервера автоматически загружается из исходников. Не пересоздавать Web Service.
Render автоматически деплоит main после публикации кода.

## Ограничения Free

Render останавливает сервис после 15 минут без входящих запросов. Следующее
Telegram webhook-сообщение будит сервис; первый ответ может задержаться примерно
на минуту или дольше из-за повторной доставки. Немедленный ответ 24/7 не обещается.
Нет искусственного keep-alive. Лимиты бесплатных Render/Neon и квоты Groq сохраняются.

## Надёжность

Webhook отвечает 200 только после фиксации update в PostgreSQL; при ошибке базы
возвращается 503, чтобы Telegram повторил доставку. Inbox/outbox/STT ledger/cache
сохраняются в Neon. Одна транзакционная advisory lock сериализует изменения и
резервирование бюджета. Runtime lease допускает одного обрабатывающего worker.
При rolling deploy standby уже может принимать сообщения в общую очередь, пока
старый worker заканчивает работу. Неизвестный результат внешнего STT/send не
повторяется автоматически. Telegram ledger по-прежнему не учитывает web STT.

## Проверка

- В шапке сайта v0.3.7 (build 15).
- /api/health: ok=true, telegram.enabled=true, telegram.ready=true.
- Лог service.ready: telegram=webhook, storage=postgres.
- /start, /new Тест, текст/voice-список, reply, /finish.
- После перезапуска /history сохраняет сметы.
- После сна сообщение боту будит Render; реальную задержку проверяет владелец.

Локально: npm ci, npm run check, npm test, npm run demo:telegram.
CI поднимает PostgreSQL 17 для интеграционных тестов. TEST_DATABASE_URL должен
указывать только на отдельную тестовую базу: тесты очищают её схему telegram.
Без тестовой базы SQL integration-тесты пропускаются. Telegram/Groq в CI — mocks.
Отдельный локальный запуск telegram/ сохраняет SQLite как диагностический режим.

Официальные источники: https://render.com/docs/free,
https://render.com/docs/environment-variables,
https://core.telegram.org/bots/api#setwebhook.
