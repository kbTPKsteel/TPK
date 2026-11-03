# feedback-worker

Посредник для формы «Написать автору» на сайте TPK Warehouse. Принимает сообщение и файлы со страницы продукта и публикует их в Slack. Токен Slack хранится только в настройках воркера, в коде сайта токенов нет.

Воркер также проверяет общий пароль организации. Без пароля сайт не даёт скачивать файлы и писать разработчикам, а просматривать каталог можно без него. Пароль меняют командой `/tpk-warehouse-password` в канале обратной связи: воркер придумывает новый случайный пароль и публикует его в канале.

## Развёртывание (через сайт Cloudflare, без командной строки)

1. **Slack.** В настройках Slack-приложения (api.slack.com/apps → ваше приложение):
   - **OAuth & Permissions → Bot Token Scopes:** должны быть `chat:write` и `files:write`.
   - Скопируйте **Bot User OAuth Token** (начинается с `xoxb-`).
   - **Basic Information → App Credentials → Signing Secret → Show** и скопируйте его.
   - Убедитесь, что бот добавлен в канал для обратной связи.
2. **Cloudflare.** Зарегистрируйтесь на dash.cloudflare.com (бесплатный тариф: 100 000 запросов в день).
   - В меню слева **Compute → Workers & Pages → Create** → **Start with Hello World!** (или **Create Worker**), имя например `tpk-feedback` → **Deploy**. Прямая ссылка: `https://dash.cloudflare.com/?to=/:account/workers-and-pages`.
   - **Edit code:** замените код содержимым `worker.js` → **Deploy**.
3. **Хранилище для пароля (KV).**
   - В меню слева **Storage & Databases → Workers KV → Create instance**, имя например `tpk-feedback` → **Create**.
   - Откройте сам воркер (**Compute → Workers & Pages → `tpk-feedback`**) → вкладка **Settings** → раздел **Bindings** → кнопка **+ Add binding** справа (туда же ведёт «Add a binding» на схеме во вкладке **Overview**).
   - Откроется окно «Add a binding»: слева список типов, справа пример кода. В левом списке выберите **KV namespace** → синяя кнопка **Add Binding** внизу. Variable name `TPK_KV`, KV namespace `tpk-feedback` → **Add Binding** / **Deploy**. В таблице Bindings должна появиться строка `TPK_KV`.
4. **Settings → Variables and Secrets → Add.** Environment: только **Production**. Все переменные можно добавить в одном окне кнопкой **+ Add**; тип задаётся галочкой **Secret** справа от поля Value:
   | Key | Value | Галочка Secret |
   |---|---|---|
   | `SLACK_BOT_TOKEN` | токен из шага 1 (`xoxb-…`) | поставить |
   | `SLACK_SIGNING_SECRET` | Signing Secret из шага 1 | поставить |
   | `SLACK_CHANNEL` | ID канала, например `C05092Y0B5X` (Slack: название канала → внизу «Channel ID») | нет |
   | `ALLOWED_ORIGIN` | `https://kbtpksteel.github.io` — без `/TPK` и без слэша в конце | нет |

   Затем **Add variable and deploy**.
5. **Команда Slack.** Сначала проверьте **Settings → Socket Mode**: он должен быть выключен. Пока Socket Mode включён, Slack скрывает поле Request URL и не отправляет команды на воркер. Затем api.slack.com/apps → приложение → **Slash Commands → Create New Command**:
   - Command: `/tpk-warehouse-password`
   - Request URL: `https://tpk-feedback.<ваш-поддомен>.workers.dev/slack` (адрес воркера + `/slack`)
   - Short Description: `Новый пароль для сайта TPK Warehouse`
   - **Save**, затем Slack попросит переустановить приложение: **Reinstall to Workspace**. Это добавит боту право `commands`, токен `xoxb-…` при этом не меняется.
6. **Первый пароль.** В канале обратной связи выполните `/tpk-warehouse-password`. Бот опубликует пароль. Пока это не сделано, сайт на вход отвечает «Пароль ещё не задан».
7. Проверьте, что адрес воркера (вида `https://tpk-feedback.<ваш-поддомен>.workers.dev`) совпадает с константой `WORKER_URL` в `docs/auth.js`. Сейчас там `https://tpk-feedback.poluhovamaria.workers.dev`; менять нужно, только если воркер создан заново под другим именем или аккаунтом.

## Что проверяет воркер

- Запросы принимаются только со страницы сайта (`ALLOWED_ORIGIN`).
- Сообщение принимается только с действующим токеном. Токен сайт получает после ввода пароля (`/login`).
- Токен подписан хешем текущего пароля и действует 180 дней. После `/tpk-warehouse-password` все выданные токены сразу перестают действовать (с задержкой до минуты из-за кеша KV).
- Неверный пароль: после 10 ошибок с одного IP вход блокируется на 15 минут.
- `/tpk-warehouse-password` принимается только с подписью Slack (`SLACK_SIGNING_SECRET`) и только из канала `SLACK_CHANNEL`. Сменить пароль может любой участник канала: доступ к паролю определяется членством в канале.
- В KV хранится только хеш пароля (PBKDF2), сам пароль нигде не сохраняется.
- Не больше 5 файлов по 5 МБ, сообщение до 4000 символов.
- Текст пользователя экранируется: через форму нельзя упомянуть `@channel`, других людей или вставить ссылку-маску.
- Упомянуть можно только автора продукта, и только по корректному Slack ID.

## Ограничение для скачивания

Файлы лежат в публичных релизах `kbTPKsteel/TPK`, и прямые ссылки на них есть в `docs/catalog.json`. Поэтому пароль перед скачиванием — это проверка только в интерфейсе: зная прямую ссылку, файл можно скачать без пароля. Сообщения разработчикам защищены полностью, потому что их проверяет воркер.
