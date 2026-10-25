# Происхождение build 12

2026-10-25, v0.3.4: владелец явно указал, что бот должен работать с любыми пользователями. Удалены allowlist и требование ALLOWED_USER_IDS из startup/ingress/callbacks; старое значение этой переменной игнорируется. Telegram ID остаётся внутренним ключом владения, пользователь ничего не настраивает. Личные чаты и изоляция смет сохранены. Это заменяет прежнее техническое ограничение закрытого MVP.

## Предыдущая интеграция: build 11

Дата: 2026-10-25, v0.3.3. По прямому решению владельца Telegram интегрирован в существующий web/Render service и репозиторий agentstroy555/prorab_talk (baseline main 631e360fad5aa711911ea7356d8fc865196178b4). Основной продуктовый фокус Telegram; прежний web UX не развивается в этой задаче.

Telegram логика взята из сохранённого v0.3.2 build 10. Корневые catalog/parser/matcher/voice-utils теперь используются напрямую, дубликаты удалены. Web parser/VAD алгоритмы не менялись. Изменены entrypoint, lifecycle, version metadata, CI и инструкция размещения.

Прежний приватный архив build 10 содержит токен по просьбе владельца и остаётся на Google Drive. Публичная интеграция использует TELEGRAM_BOT_TOKEN из Render Environment и не содержит секрета. Настоящие Telegram/Groq и платные ресурсы не настраивались. Смета по-прежнему означает список материалов без цен/поставщиков.

Node 24 + SQLite — текущий выбор реализации, не вечное ограничение. Postgres backend бота и синхронизация смет между каналами в эту задачу не входят. Лимиты бота не являются общим бюджетом с web STT.

Официальные источники: https://core.telegram.org/bots/api ; https://console.groq.com/docs/speech-to-text ; https://nodejs.org/api/sqlite.html ; https://render.com/docs/disks ; https://render.com/docs/node-version .
