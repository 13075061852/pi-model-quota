# Pi Model Quota

[![CI](https://github.com/13075061852/pi-model-quota/actions/workflows/ci.yml/badge.svg)](https://github.com/13075061852/pi-model-quota/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.18-green.svg)](package.json)

**在 Pi 终端页脚查看当前模型的订阅额度、API 限额和账户余额。**

A lightweight Pi extension for model quota, balance, reset times, and confirmed Codex reset-card redemption. No third-party runtime dependencies.

```text
◆ 额度[订阅] 5h 82% ↻ 09-06 14:30 · 7d 47% ↻ 09-10 09:00 · 重置卡 2次
◆ 额度[Key] 请求 90% · Token 40%
◆ 额度[Key] ¥108.42
```

> 示例仅用于展示格式，不代表真实账户数据。插件显示上游实际公开的信息，不推算或伪造账户余额。

## 安装

需要 **Node.js 22.18+** 和支持本扩展事件及认证 API 的 [Pi](https://github.com/earendil-works/pi-mono)。建议使用当前稳定版本的 Pi。

```bash
pi install git:github.com/13075061852/pi-model-quota
```

安装后重启 Pi，或在 Pi 输入框执行 `/reload`。

```bash
# 更新此插件
pi update git:github.com/13075061852/pi-model-quota

# 卸载
pi remove git:github.com/13075061852/pi-model-quota
```

本项目是 **Pi Package**：`index.ts` 扩展负责常驻页脚和查询；附带的 `/skill:model-quota` 仅提供使用及排障说明，不能替代扩展。

## 功能

- **跟随模型切换**：自动识别订阅、OAuth 和 API Key 认证。
- **分别显示重置时间**：5 小时和周额度各自附带本地日期与时间。
- **重置卡**：显示 Codex 可用次数，支持用户确认后使用一张已有重置卡。
- **过渡动画**：重置成功并取得新额度后，用约 1 秒的百分比渐变更新页脚。
- **轻量余额显示**：例如 `额度[Key] ¥108.42`，不重复显示“余额”标签。
- **颜色提示**：剩余 >50% 绿色、26–50% 青色、11–25% 黄色、≤10% 红色（具体色值跟随主题）。
- **无额外模型调用**：主动查询账户接口，或被动解析正常模型请求的响应头。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/quota` | 查看额度窗口、认证方式、数据来源和重置时间 |
| `/quota refresh` | 立即刷新支持主动查询的账户额度 |
| `/quota debug` | 查看诊断摘要，不输出 token 或原始响应头 |
| `/quota reset` | 确认后使用 1 张 OpenAI Codex 重置卡 |

### 使用 OpenAI Codex 重置卡

1. 选择通过 OAuth/订阅登录的 `openai-codex` 模型。
2. 等待模型请求结束，输入 `/quota reset`。
3. 阅读确认弹窗；确认后消耗当前账户的一张已有重置卡，**不购买额度**。
4. 成功后自动刷新额度、重置时间及卡次数，并播放页脚渐变动画。

**注意：**

- 这是实际账户操作，不可撤销。未确认、非交互模式或不支持的认证方式不会发送重置请求。
- 只有官方返回满额时才显示 100%；动画不是模拟重置成功。
- 超时或响应无法确认时，卡可能已经被消耗。插件不会自动重试，并阻止本次扩展加载期间再次使用。**先到官方 Usage 页面核实，不要通过重载盲目重试。**
- 如果提示“重置已成功，但额度刷新失败”，只运行 `/quota refresh`，不要再用一张卡。
- 防重复提交锁仅限当前扩展实例，不跨 Pi 进程；请勿在多个窗口同时兑换。
- 使用 [官方 Codex 客户端采用的接口](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs)，并非稳定公共 API，可能随上游变化。

## 支持的平台

### 主动查询账户接口

| Provider | 认证 | 显示内容 |
| --- | --- | --- |
| `openai-codex` | OAuth / ChatGPT 订阅 | 5h、7d 等窗口、Credits、可用重置卡 |
| `anthropic` | OAuth / Claude 订阅 | 5h、7d、模型专属窗口及额外用量预算 |
| `openrouter` | API Key / OAuth Key | Key 预算或接口返回的剩余金额 |
| `kimi-coding` | API Key / OAuth | Coding Plan 用量窗口 |
| `zai` / `zai-coding-cn` | API Key | Coding Plan 额度 |
| `deepseek` | API Key | 账户余额 |

以上为代码适配范围，不保证每个账户或套餐均公开相同字段。

### 被动读取响应头

其他平台或 API Key 登录可读取以下信息：

- OpenAI 兼容的 `x-ratelimit-*` 请求与 Token 限额；
- Anthropic 常规限额及 unified 5h/7d 字段；
- Codex 多窗口限额字段；
- 标准 `ratelimit-*` 字段和 HTTP 429 的 `retry-after`。

不会为了获取这些字段额外发送付费模型请求；通常需要先完成一次正常模型请求。

## 配置与显示规则

| 环境变量 | 默认值 | 范围 |
| --- | --- | --- |
| `PI_MODEL_QUOTA_REFRESH_SECONDS` | `60` | 30–3600 秒 |

修改环境变量后重启 Pi。自动刷新仅在有 UI 的会话中启动。

- 页脚优先显示最多两个有百分比的窗口，否则显示最多两个余额/数量；完整信息见 `/quota`。
- 重置时间使用本地时区；未返回或已过期的时间不显示。
- 订阅额度、账户余额与 RPM/TPM 限流是不同指标；部分额度由整个账号共享，并非模型独占。
- 瞬时查询失败会保留上次成功数据。查看 `/quota` 的更新时间和 `/quota debug` 的错误，不要将缓存视作实时保证。
- 上游没有可用字段时显示“上游未公开”；首次请求前可能显示“等待首次请求”。

## 安全与隐私

- 凭据由 Pi 的认证注册表读取，不需要在插件中额外配置 Key。
- 账户接口地址内置并拒绝重定向；自定义认证来源不会被用于向官方接口发送重置请求。
- 重置 POST 要求明确匹配官方来源，并在确认后重新核验凭据。
- 不持久化额度、token、提示词或模型响应；不会注册供模型调用的重置工具。
- 查询代理支持取决于 Node 的 `http.setGlobalProxyFromEnv` 是否可用；旧运行时不保证环境代理生效。若使用代理，建议使用提供该 API 的新版 Node。
- 网络查询临时设置进程级代理并在结束后恢复。与其他网络扩展共用进程时仍需注意代理兼容性。

发现安全问题请阅读 [SECURITY.md](SECURITY.md)，不要公开上传认证文件。

## 排障

1. 确认插件已启用，执行 `/reload`。
2. 执行 `/quota refresh`，再用 `/quota debug` 查看摘要。
3. 检查 `/login`、当前 provider 和自定义 `baseUrl`。
4. 若依赖代理，检查 Node 版本及 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`。
5. 重置结果不确定时，先核实官方账户状态，勿反复兑换。

提交问题请使用 [Issue 模板](https://github.com/13075061852/pi-model-quota/issues/new/choose)，仅附脱敏信息。

## 开发

```bash
git clone https://github.com/13075061852/pi-model-quota.git
cd pi-model-quota
npm test

# 将本地目录作为 Pi Package 加载；避免同时启用远程副本
pi install .
```

测试使用 Node 内置测试框架；重置功能测试使用伪造凭据和 mock fetch，**禁止用真实重置卡做自动测试**。GitHub Actions 在 Linux 和 Windows 的 Node 22/24 上运行测试。

```text
index.ts                    生命周期、命令、页脚和重置动画
probes.ts                   账户查询与确认后的重置请求
quota-core.ts               解析、合并与格式化
skills/model-quota/         使用说明 Skill
tests/                      单元测试与模拟交互测试
```

欢迎提交 Issue / PR。参见 [贡献指南](CONTRIBUTING.md) 和 [更新日志](CHANGELOG.md)。

## License

[MIT](LICENSE)
