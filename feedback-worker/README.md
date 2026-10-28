# feedback-worker

Посредник для формы «Написать автору» на сайте TPK Warehouse. Принимает сообщение и файлы со страницы продукта и публикует их в Slack. Токен Slack хранится только в настройках воркера, в коде сайта токенов нет.

## Развёртывание (через сайт Cloudflare, без командной строки)

1. **Slack.** В настройках Slack-приложения (api.slack.com/apps → ваше приложение):
   - **OAuth & Permissions → Bot Token Scopes:** должны быть `chat:write` и `files:write`. Если `files:write` добавлялся сейчас, нажмите **Reinstall to Workspace**.
   - Скопируйте **Bot User OAuth Token** (начинается с `xoxb-`).
   - Убедитесь, что бот добавлен в канал для обратной связи.
2. **Cloudflare.** Зарегистрируйтесь на dash.cloudflare.com (бесплатный тариф: 100 000 запросов в день).
   - В меню слева **Compute → Workers & Pages → Create** → **Start with Hello World!** (или **Create Worker**), имя например `tpk-feedback` → **Deploy**. Прямая ссылка: `https://dash.cloudflare.com/?to=/:account/workers-and-pages`.
   - **Edit code:** замените код содержимым `worker.js` → **Deploy**.
3. **Settings → Variables and Secrets → Add.** Environment: только **Production**. Все три переменные можно добавить в одном окне кнопкой **+ Add**; тип задаётся галочкой **Secret** справа от поля Value:
   | Key | Value | Галочка Secret |
   |---|---|---|
   | `SLACK_BOT_TOKEN` | токен из шага 1 (`xoxb-…`) | поставить |
   | `SLACK_CHANNEL` | ID канала, например `C05092Y0B5X` (Slack: название канала → внизу «Channel ID») | нет |
   | `ALLOWED_ORIGIN` | `https://kbtpksteel.github.io` — без `/TPK` и без слэша в конце | нет |

   Затем **Add variable and deploy**.
4. Скопируйте адрес воркера (вида `https://tpk-feedback.<ваш-поддомен>.workers.dev`) и пропишите его в `docs/product.html` в константу `FEEDBACK_URL`.

## Что проверяет воркер

- Запросы принимаются только со страницы сайта (`ALLOWED_ORIGIN`).
- Не больше 5 файлов по 5 МБ, сообщение до 4000 символов.
- Текст пользователя экранируется: через форму нельзя упомянуть `@channel`, других людей или вставить ссылку-маску.
- Упомянуть можно только автора продукта, и только по корректному Slack ID.
