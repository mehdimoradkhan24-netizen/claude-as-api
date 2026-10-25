# claude-as-api

سرور سازگار با **Anthropic Messages API** (`POST /v1/messages`، بدون تبدیل به OpenAI) که روی **Claude Agent SDK** ساخته شده است.

- **Streaming واقعی**: رویدادهای SSE (`message_start`, `content_block_delta`, …) هم‌زمان با تولید ارسال می‌شوند.
- **Session پایدار**: برای هر مکالمه یک `query()` زنده در حالت streaming-input نگه داشته می‌شود (کلید: هدر `x-session-id` یا هش پیام اول). با تغییر مجموعهٔ ابزارها، session با `resume` دوباره ساخته می‌شود.
- **ابزارها در سیستم B اجرا می‌شوند**: ابزارهای ارسالی کلاینت (`tools` در درخواست) از طریق یک MCP داخلی به Claude داده می‌شوند. وقتی Claude ابزاری را صدا بزند، پاسخ HTTP با `stop_reason: "tool_use"` تمام می‌شود و اجرای ابزار تا رسیدن `tool_result` در درخواست بعدی منتظر می‌ماند. ابزارهای داخلی Claude Code خاموش‌اند.

## سیستم A
1. Node 18+ نصب باشد.
2. `start-claude-code.bat` را اجرا کنید (مقادیر `PORT` و `PROXY_API_KEY` را بالای فایل عوض کنید). این فایل Claude Code و وابستگی‌ها را نصب می‌کند، در اولین اجرا login می‌گیرد، پورت فایروال را باز می‌کند و سرور را بالا می‌آورد.
   - احراز هویت: `claude` login یا متغیر `ANTHROPIC_API_KEY`.

## سیستم B (VS Code Copilot)
در Copilot Chat → Manage Models یک مدل Anthropic/سفارشی اضافه کنید و Base URL را `http://<IP-سیستم-A>:8787` و کلید را همان `PROXY_API_KEY` بگذارید.
(نام دقیق تنظیم بسته به نسخهٔ VS Code فرق می‌کند؛ من این بخش را روی VS Code واقعی تست نکرده‌ام.)
هر ابزاری که Copilot ارسال کند (ویرایش فایل، ترمینال، …) روی سیستم B اجرا می‌شود.

تست دستی:
```
curl http://<IP-A>:8787/v1/messages -H "x-api-key: KEY" -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5-5","max_tokens":200,"stream":true,"messages":[{"role":"user","content":"سلام"}]}'
```

## متغیرها
`PORT`, `HOST`, `PROXY_API_KEY` (خالی = بدون احراز هویت)، `CLAUDE_MODEL`, `SESSION_TTL_MIN`.
`npm test` یک تست آفلاین با SDK ساختگی اجرا می‌کند.

## لاگ
هر درخواست (هدرها با کلید پنهان‌شده، بدنه، رویدادهای SSE، وضعیت و زمان پاسخ، خطاها) هم در کنسول و هم در `claude-as-api.log` ثبت می‌شود.
متغیرها: `LOG_FILE` (خالی = فقط کنسول)، `LOG_BODY_MAX` (تعداد کاراکتر بدنهٔ لاگ‌شده؛ پیش‌فرض ۳۰۰۰، `0` = بدون بدنه).
