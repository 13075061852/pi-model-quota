# Pi Model Quota（全局额度状态插件）

在 Pi 默认页脚中显示**当前模型**的剩余额度，自动识别订阅 OAuth、普通 OAuth 和 API Key 登录。

## 从 GitHub 一行安装

```bash
pi install git:github.com/<GitHub用户名>/pi-model-quota
```

安装后重新启动 Pi；如果从正在运行的 Pi 内安装，也可以执行 `/reload`。

更新或卸载：

```bash
pi update git:github.com/<GitHub用户名>/pi-model-quota
pi remove git:github.com/<GitHub用户名>/pi-model-quota
```

> 本项目以 **Pi Package** 发布：Extension 负责页脚、事件监听和额度查询；`skills/model-quota/SKILL.md` 仅提供 `/skill:model-quota` 使用及排障说明。单独的 Skill 无法实现常驻页脚。

```text
◆ 额度[订阅] 5h 82% · 7d 47% · ↻ 05-01 14:30
额度[Key] 请求 90% · Token 40%
额度[Key] 预算/monthly 74%
```

## 功能

- 页脚状态始终跟随当前模型，切换 `/model` 后自动切换。
- 订阅模型显示最近一次额度重置的本地日期和时间。
- `/quota`：显示当前模型的额度、重置时间、认证方式和数据来源。
- `/quota refresh`：立即刷新账户额度接口。
- `/quota debug`：显示脱敏诊断信息（不输出 token 和原始响应头）。
- 使用青色 `◆ 额度` 专用标记；剩余量 >50% 为绿色、26–50% 为青色、11–25% 为黄色、≤10% 为红色，查询失败也显示红色。
- 默认每 60 秒刷新；设置 `PI_MODEL_QUOTA_REFRESH_SECONDS=120` 可修改（范围 30–3600 秒）。

## 支持方式

### 主动查询（不产生模型 token 费用）

| Provider | 登录方式 | 数据源 |
|---|---|---|
| `openai-codex` | ChatGPT Plus/Pro 订阅 | ChatGPT Codex usage |
| `anthropic` | Claude OAuth 订阅 | Anthropic OAuth usage |
| `openrouter` | API Key / OAuth Key | `/api/v1/key` 预算 |
| `kimi-coding` | API Key / OAuth | Coding usages |
| `zai` / `zai-coding-cn` | API Key | Coding Plan quota |
| `deepseek` | API Key | `/user/balance` 账户余额 |

### 被动读取响应头

对其他提供商和 API Key 登录，插件从 Pi 的 `after_provider_response` 事件读取：

- OpenAI/xAI/Groq 等常见 `x-ratelimit-*` 请求与 token 额度；
- Anthropic `anthropic-ratelimit-*` 与 unified 5h/7d 额度；
- Codex `x-codex-*` 多额度窗口；
- 标准 `ratelimit-*` / `x-ratelimit-*` 字段；
- HTTP 429 的 `retry-after`。

插件不会为了获取 API Key 限额而额外发送付费模型请求；首次正常请求完成后，页脚会自动更新。

## 重要限制

“所有 Key/订阅都显示真实账户余额”在技术上并不存在统一实现：部分厂商只返回瞬时 RPM/TPM，部分厂商完全不公开余额接口，OpenAI 账户消费接口还可能要求组织 Admin Key。遇到这种情况插件会明确显示 `上游未公开`，不会伪造额度。

因此：

- **认证方式都支持**；
- **可显示的数据取决于上游实际公开的接口或响应头**。

## 手动安装（开发用途）

将整个目录复制到 `~/.pi/agent/extensions/model-quota/`。插件只使用 Node 内置模块，**没有第三方运行依赖**，然后执行 `/reload`。Pi 会在所有项目中自动加载该扩展。

## 安全设计

- 账户查询只访问内置白名单官方域名，并拒绝重定向。
- 代理连接使用 Node 内置环境代理，并在额度请求完成后立即恢复原进程配置。
- 若当前模型被改为代理/自定义域名，不会把凭据发送到官方额度端点或其他来源。
- 不写入 token、原始响应头、提示词或模型响应。
- 不持久化额度数据；退出会话即清除。

## 开发测试

```bash
node --experimental-strip-types --test tests/*.test.ts
pi -e ./index.ts --list-models
```
