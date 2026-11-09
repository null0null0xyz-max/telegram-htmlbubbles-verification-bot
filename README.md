# Telegram HTMLBubbles verification bot

MVP Telegram-бота на нативных **Telegram Widgets (HTMLBubbles)**, а не Mini App. Бот отправляет автономный HTML-пузырь через `sendWidget`, разбивает загруженное из интернета изображение на сетку 3×3, принимает выбор через `TelegramWidget.request()` и обрабатывает `widget_query` через webhook.

## Что важно

HTMLBubbles запускаются в изолированной QuickJS-песочнице Telegram без сети. Поэтому изображения скачивает сервер бота, превращает клетки в `data:` URL и встраивает их прямо в HTML. Лимиты Telegram: HTML до 32 КБ и до 4 КБ после zlib-сжатия; запрос от виджета — 1–64 байта.

Текущий MVP содержит два демонстрационных источника изображений и эталонные ответы. Для production CAPTCHA нужно заменить их на проверенный каталог изображений с разметкой или подключить серверный vision-классификатор. Не используйте этот прототип для обхода чужих CAPTCHA.

## Локальный запуск

```bash
npm ci
BOT_TOKEN='токен_бота' PUBLIC_URL='https://your-domain.example' WEBHOOK_SECRET='случайная_строка' npm start
```

Проверьте `GET /healthz`, затем отправьте боту `/start`.

## Render

Сервис рассчитан на Render Web Service. Добавьте в Environment переменную `BOT_TOKEN`; `PUBLIC_URL` не обязателен, код использует автоматически предоставленный Render `RENDER_EXTERNAL_URL`. После перезапуска бот сам устанавливает webhook на `/telegram/webhook`.

## Команды

- `/start` или `/verify` — отправить новый HTMLBubbles-челлендж.
- `/help` — показать помощь.
