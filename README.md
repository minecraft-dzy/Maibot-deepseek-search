# Maibot DeepSeek 官方联网搜索插件

把 **DeepSeek 官方 Search API** 接入 [MaiBot](https://github.com/MaiM-with-u/maibot)，让麦麦可以联网检索实时信息，并在回答中引用来源链接。

- 官方文档：[Search & Fetch | DeepSeek API Docs](https://api-docs.deepseek.com/guides/search/)
- 接口：`POST https://api.deepseek.com/v1/tools/search`
- 认证：`Authorization: Bearer <DeepSeek API Key>`

## 功能

- `deepseek_web_search` 工具：planner 在需要实时信息时自动调用，返回标题、链接、来源站点、日期与摘要。
- `/dssearch <搜索词>` 命令：在聊天中手动触发一次搜索，便于验证插件是否正常工作。
- 支持官方检索语法：`site:`、`-site:`、`"精确短语"`、`lang:zh,en`、`after:2025-01-01`、`before:2026-06-01` 等。
- 可选 `need_content`：让官方顺带抓取网页正文（Markdown），适合需要深入阅读页面的场景。
- 结果会按配置截断，避免一次搜索占用过多上下文。

## 安装

1. 将本仓库放到 MaiBot 的 `plugins/` 目录下（目录名任意，例如 `deepseek-search-plugin`）。
2. 在 MaiBot 使用的 Python 环境中安装依赖：

   ```bash
   pip install -r requirements.txt
   ```

3. 启动 MaiBot，插件会自动生成 `config.toml` 并加载。若未自动加载，请在 WebUI 插件页启用后重启一次。

## 配置

首次加载后插件目录下会生成 `config.toml`：

```toml
[plugin]
enabled = true
config_version = "1.0.0"

[search]
api_key = ""                 # 填写 DeepSeek API Key，留空则读取环境变量 DEEPSEEK_API_KEY
base_url = "https://api.deepseek.com"
default_count = 5            # 默认返回条数
max_count = 20               # 单次最大条数（官方上限 50）
need_content = false         # 默认是否抓取正文
timeout_sec = 20.0
proxy = ""                   # 可选，例如 http://127.0.0.1:7890
max_output_chars = 3000      # 返回给模型的最大字符数
max_content_chars = 600      # 单条正文最大字符数
```

API Key 可以在 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 获取。

## 使用

- 自动模式：直接向麦麦提问需要时效性的问题，planner 会调用 `deepseek_web_search`。
- 手动模式：发送 `/dssearch 今天的科技新闻`。

工具参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `query` | string | 是 | 搜索关键词，支持官方检索语法 |
| `count` | integer | 否 | 返回条数，留空使用 `default_count` |
| `need_content` | boolean | 否 | 是否返回网页正文 |

## 兼容性

- MaiBot Host：`>= 1.0.0`
- Plugin SDK：`>= 2.0.0`
- Python：`>= 3.10`

## 目录结构

```text
.
├── _manifest.json   # 插件清单
├── plugin.py        # 插件实现（Tool + Command）
├── requirements.txt
├── LICENSE
└── README.md
```

## License

Apache-2.0
