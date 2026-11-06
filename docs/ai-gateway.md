# Use your own AI gateway

You can set up your own AI gateway and run Claude Code and Codex chats in the
desktop app through it. That can be LiteLLM, OpenRouter, or a company proxy in
front of your own models.

## What your gateway needs

- **An HTTPS base URL**, such as `https://gateway.example.com`. Plain HTTP
  isn't accepted, even for `localhost`. The URL can't contain a username or
  password, a query string, or a fragment. A trailing `/v1` is fine: the app
  removes it.
- **`GET /v1/models`**, so the app can find your models. It reads the common
  list formats, including those from OpenAI, Anthropic, LiteLLM, and
  OpenRouter. The gateway must answer within 10 seconds, without a redirect,
  and the list must be smaller than 1 MB.
- **`POST /v1/messages`** in the Anthropic Messages format, for Claude Code
  models. Claude Code can also call `POST /v1/messages/count_tokens`.
- **`POST /v1/responses`** in the OpenAI Responses format, for Codex models.
  Codex uses your gateway URL with `/v1` added, and calls `/responses` on it.
- **An API key.** When the app lists your models, it sends the key in both the
  `Authorization: Bearer` and `x-api-key` headers, with an `anthropic-version`
  header.

The desktop app connects to your gateway directly, so a gateway on a VPN or
private network works.

## Set it up for yourself

1. In the desktop app, open **Settings → AI gateway**.
2. Enter your **Gateway URL** and **API key**, then select **Connect**.
3. Every model your gateway lists is checked. Untick any you don't want.
4. Optionally, enter a **Name**. It shows the gateway's host name until you do.
5. Select **Save**.

Your gateway's models now have their own section in the model picker. To hide
every other model, turn on **Use only my AI gateway**.

There are two other ways to set it up:

- **First run:** on the desktop app's first screen, select
  **Use your own AI gateway**.
- **From a chat:** ask the agent, for example "Set up my AI gateway at
  gateway.example.com." An approval card asks "Connect AI gateway
  **gateway.example.com**?" Type your key into the card's masked field and
  select **Allow**. The key goes straight to secure storage, never into the
  chat. A second card asks before the agent saves the gateway.

## Set it up for an organization

Organization owners and admins can offer a gateway to everyone in the
organization:

1. In the desktop app, open your organization's settings, then **AI gateway**,
   and connect it the same way.
2. Turn on **Offer to members**.
3. To make it the only option, open **Policies** and turn on
   **Require members to use only the AI gateway**. The **Manage AI gateway**
   link under it takes you back to the gateway page.

Each member adds their own **API key** on their desktop, in
**Settings → Providers**. The gateway is the first row there. Keys are never
shared between members.

## Where your key and settings live

- **Your API key** is encrypted with your operating system's secure storage and
  stays on your desktop. We never store it.
- **The gateway URL, name, and model list** are saved to your account, or to
  your organization for a shared gateway. So you need to be signed in to use a
  gateway today.
- **Only Claude Code and Codex chats in the desktop app** can use gateway
  models.

See [what runs on our servers](../HOSTED-SERVICES.md) for everything else the
apps send to us.

## Change your models

- **Refresh models** lists models your gateway added since you connected it.
  Select **Add model manually** for one it doesn't list.
- **Edit** sets a model's **Harness** (Claude or Codex), **Context window**,
  **Thinking levels**, and **Flat tool schema**. The app picks defaults for you,
  so you only need these when a model misbehaves.
- **Remove** takes a model out of your list.

## Example: LiteLLM

[LiteLLM](https://docs.litellm.ai/docs/proxy/configs) can serve all three
endpoints. This `config.yaml` offers one Claude model and one OpenAI model, and
reads every key from an environment variable:

```yaml
model_list:
  - model_name: claude-sonnet-5
    litellm_params:
      model: anthropic/claude-sonnet-5
      api_key: os.environ/ANTHROPIC_API_KEY
  - model_name: gpt-5
    litellm_params:
      model: openai/gpt-5
      api_key: os.environ/OPENAI_API_KEY

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
```

Use the model names your providers offer. Then:

1. Set `LITELLM_MASTER_KEY` to a long, random key you choose, then start the
   proxy with `litellm --config config.yaml`. It listens on port 4000.
2. Put it behind an HTTPS reverse proxy, so it's reachable at an address such
   as `https://litellm.example.com`.
3. In **Settings → AI gateway**, enter that address as the **Gateway URL** and
   your master key as the **API key**.

LiteLLM documents each endpoint the app uses:

- [Listing models](https://docs.litellm.ai/docs/proxy/model_access)
- [Anthropic Messages](https://docs.litellm.ai/docs/anthropic_unified)
- [Counting tokens](https://docs.litellm.ai/docs/anthropic_count_tokens)
- [OpenAI Responses](https://docs.litellm.ai/docs/response_api)

**OpenRouter:** use `https://openrouter.ai/api` as the **Gateway URL** and an
OpenRouter API key. It serves
[Anthropic Messages](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message)
for Claude Code models. Its
[Responses API](https://openrouter.ai/docs/api_reference/responses/overview)
doesn't support every model, so check that a model supports it before you use
it with Codex.

## Troubleshooting

| Message                                                         | What it means                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Enter a valid HTTPS gateway URL.                                | The URL isn't HTTPS, or has a username, password, query string, or fragment.   |
| Your gateway didn't accept that API key.                        | The gateway answered 401 or 403.                                               |
| Couldn't reach your gateway. Check the URL and your connection. | Any other error, no answer within 10 seconds, a redirect, or a list over 1 MB. |
| The gateway rejected this API key.                              | In **Settings → Providers**: the gateway answered 401 or 403.                  |
| Unable to reach the AI gateway.                                 | In **Settings → Providers**: any other error, timeout, or redirect.            |

To report a security problem with this feature, see [SECURITY.md](../SECURITY.md).
