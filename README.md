# Ultimate Chess App — Telegram Mini App

Шахматы внутри Telegram: анимированная доска, SVG-фигуры (Neo / Классика), темы Telegram,
MainButton / BackButton, вибро-отклик, звуки, Stockfish (1–5) и Pass & Play.

## Структура

```
ultimate-chess/
├── index.html          # SDK Telegram + экраны (меню / настройки / игра)
├── css/style.css       # темы Telegram (CSS-переменные) + web3 glassmorphism
└── js/
    ├── main.js         # контроллер: экраны, партии, настройки
    ├── board.js        # доска с анимацией фигур (CSS transform transitions)
    ├── pieces.js       # собственный SVG-спрайт фигур (Neo)
    ├── engine.js       # Stockfish.js в Web Worker (UCI)
    ├── sound.js        # звуки ходов на WebAudio (без ассетов)
    └── tg.js           # мост Telegram: тема, MainButton/BackButton, haptics, профиль
```

## Локальный запуск

Нужен любой статический сервер (ES-модули не работают с `file://`):

```bash
python -m http.server 8099
# открыть http://localhost:8099/ultimate-chess/
```

В обычном браузере приложение полностью играбельно: вместо нативных MainButton/BackButton
работают внутриэппные кнопки («Начать игру», «‹»). Тема берётся светлая по умолчанию.

## Деплой и тест в Telegram

1. **Хостинг с HTTPS** (обязательно): GitHub Pages, Netlify, Vercel или Cloudflare Pages.
   Загрузите содержимое папки `ultimate-chess/` в корень сайта.
   Пример URL: `https://<user>.github.io/<repo>/`.
2. **Создание бота**: в [@BotFather](https://t.me/BotFather) → `/newbot`, получите токен.
3. **Привязка Mini App** (один из способов):
   - `/newapp` → выберите бота → задайте имя/описание/иконку → укажите HTTPS-URL приложения;
     запуск: `https://t.me/<bot>/<appname>`;
   - либо `/mybots` → *Bot Settings* → *Menu Button* → укажите HTTPS-URL — кнопка появится в чате бота.
4. Откройте приложение **внутри Telegram** (не в браузере):
   - интерфейс сам перекрасится под светлую/тёмную тему клиента (`tg.themeParams`, событие `themeChanged`);
   - нижняя кнопка «Начать игру» — это Telegram **MainButton**, «‹» в игре/настройках — **BackButton**;
   - взятия/шах/мат дают вибро-отклик через `HapticFeedback`.

## Зависимости

- `chess.js` и `stockfish.js` подтягиваются с jsDelivr CDN — нужен интернет на клиенте.
- Telegram Web Apps SDK: `https://telegram.org/js/telegram-web-app.js`.

## Проверено

- меню/настройки/игра, переключение тем доски и сохранение настроек (localStorage);
- Pass & Play: ходы, взятия (+материал), отмена, переворот;
- бот Stockfish: ответ на ход, индикатор «бот думает»;
- подсветки ходов/последнего хода/шаха, превращение пешки, оверлей окончания партии.
