"""DeepSeek 官方联网搜索插件。

通过 DeepSeek 官方 Search API（``POST /v1/tools/search``）为麦麦提供实时联网
检索能力：planner 可以调用 ``deepseek_web_search`` 工具，用户也可以在聊天中
使用 ``/dssearch <搜索词>`` 手动检索。
"""

from __future__ import annotations

import os
import re
from typing import Any

import httpx

from maibot_sdk import Command, Field, MaiBotPlugin, PluginConfigBase, Tool
from maibot_sdk.types import ToolParameterInfo, ToolParamType

DEFAULT_BASE_URL = "https://api.deepseek.com"
SEARCH_PATH = "/v1/tools/search"
ENV_API_KEY = "DEEPSEEK_API_KEY"


class PluginSectionConfig(PluginConfigBase):
    """插件基础配置。"""

    __ui_label__ = "插件"
    __ui_icon__ = "package"
    __ui_order__ = 0

    enabled: bool = Field(default=True, description="是否启用插件")
    config_version: str = Field(default="1.0.0", description="配置版本")


class SearchConfig(PluginConfigBase):
    """联网搜索配置。"""

    __ui_label__ = "联网搜索"
    __ui_icon__ = "search"
    __ui_order__ = 1

    api_key: str = Field(
        default="",
        description="DeepSeek API Key；留空时读取环境变量 DEEPSEEK_API_KEY",
    )
    base_url: str = Field(
        default=DEFAULT_BASE_URL,
        description="DeepSeek API 地址，通常无需修改",
    )
    default_count: int = Field(default=5, description="默认返回结果数量")
    max_count: int = Field(default=20, description="单次请求允许的最大结果数量（官方上限 50）")
    need_content: bool = Field(default=False, description="默认是否抓取网页正文")
    timeout_sec: float = Field(default=20.0, description="单次请求超时时间（秒）")
    proxy: str = Field(default="", description="可选 HTTP 代理，例如 http://127.0.0.1:7890")
    max_output_chars: int = Field(default=3000, description="返回给模型的最大字符数")
    max_content_chars: int = Field(default=600, description="单条结果正文的最大字符数")


class DeepSeekSearchPluginConfig(PluginConfigBase):
    """插件配置模型。"""

    plugin: PluginSectionConfig = Field(default_factory=PluginSectionConfig)
    search: SearchConfig = Field(default_factory=SearchConfig)


class DeepSeekSearchPlugin(MaiBotPlugin):
    """DeepSeek 官方联网搜索插件。"""

    config_model = DeepSeekSearchPluginConfig

    async def on_load(self) -> None:
        """插件加载完成时输出关键配置状态。"""

        self._get_logger().info(
            "DeepSeek 联网搜索插件已加载：endpoint=%s，API Key=%s",
            self._endpoint(),
            "已配置" if self._resolve_api_key() else "未配置",
        )

    async def on_unload(self) -> None:
        """插件卸载时的清理钩子。"""

    async def on_config_update(self, scope: str, config_data: dict[str, object], version: str) -> None:
        """跟随配置热重载刷新状态。"""

        del scope, config_data, version

    # ===== Tool 组件 =====

    @Tool(
        "deepseek_web_search",
        description=(
            "使用 DeepSeek 官方联网搜索 API 检索实时网页信息，返回标题、链接与摘要。"
            "适合查询新闻、时效性信息或需要引用来源的问题；支持 site:、after:、lang: 等检索语法。"
        ),
        parameters=[
            ToolParameterInfo(
                name="query",
                param_type=ToolParamType.STRING,
                description="搜索关键词或问题，支持 site:example.com、after:2025-01-01 等检索语法",
                required=True,
            ),
            ToolParameterInfo(
                name="count",
                param_type=ToolParamType.INTEGER,
                description="返回结果数量（1-20），留空时使用插件配置的默认值",
                required=False,
            ),
            ToolParameterInfo(
                name="need_content",
                param_type=ToolParamType.BOOLEAN,
                description="是否返回网页正文，默认关闭；需要深入阅读页面时开启",
                required=False,
            ),
        ],
    )
    async def handle_deepseek_search(
        self,
        query: str = "",
        count: int = 0,
        need_content: bool | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """执行联网搜索并返回格式化结果。"""

        del kwargs

        normalized_query = str(query or "").strip()
        if not normalized_query:
            return {"name": "deepseek_web_search", "content": "搜索失败：查询词不能为空。"}

        try:
            wanted = int(count or 0)
        except (TypeError, ValueError):
            wanted = 0

        content = await self._search(normalized_query, wanted, need_content)
        return {"name": "deepseek_web_search", "content": content}

    # ===== Command 组件 =====

    @Command(
        "dssearch",
        description="使用 DeepSeek 官方联网搜索检索信息",
        pattern=r"^/dssearch\s+(?P<query>.+)$",
    )
    async def handle_dssearch_command(self, stream_id: str = "", **kwargs: Any) -> tuple[bool, str, bool]:
        """在聊天中手动触发一次联网搜索。"""

        query = ""
        matched_groups = kwargs.get("matched_groups")
        if isinstance(matched_groups, dict):
            query = str(matched_groups.get("query") or "").strip()

        if not query:
            raw_text = str(kwargs.get("text") or "").strip()
            match = re.match(r"^/dssearch\s+(?P<query>.+)$", raw_text, re.DOTALL)
            if match is not None:
                query = match.group("query").strip()

        if not query:
            await self.ctx.send.text("用法：/dssearch <搜索词>", stream_id)
            return False, "缺少搜索词", True

        content = await self._search(query, 0, None)
        await self.ctx.send.text(content, stream_id)
        return True, "已返回搜索结果", True

    # ===== 内部实现 =====

    def _endpoint(self) -> str:
        """根据 base_url 推导 Search API 地址。"""

        base_url = str(self.config.search.base_url or "").strip().rstrip("/")
        if not base_url:
            base_url = DEFAULT_BASE_URL
        if base_url.endswith("/tools/search"):
            return base_url
        if base_url.endswith("/v1"):
            return f"{base_url}/tools/search"
        return f"{base_url}{SEARCH_PATH}"

    def _resolve_api_key(self) -> str:
        """读取配置中的 API Key，缺省时回退到环境变量。"""

        api_key = str(self.config.search.api_key or "").strip()
        if api_key:
            return api_key
        return str(os.environ.get(ENV_API_KEY) or "").strip()

    async def _search(self, query: str, count: int, need_content: bool | None) -> str:
        """调用 DeepSeek Search API 并格式化为文本。"""

        config = self.config.search
        api_key = self._resolve_api_key()
        if not api_key:
            return (
                "搜索失败：未配置 DeepSeek API Key。"
                "请在插件 config.toml 的 [search].api_key 中填写，或设置环境变量 DEEPSEEK_API_KEY。"
            )

        max_count = max(1, int(config.max_count or 20))
        wanted = count if count > 0 else int(config.default_count or 5)
        wanted = min(max(1, wanted), max_count)
        with_content = config.need_content if need_content is None else bool(need_content)

        payload: dict[str, Any] = {
            "query": query,
            "count": wanted,
            "need_content": with_content,
        }
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        proxy = str(config.proxy or "").strip() or None
        timeout = httpx.Timeout(max(5.0, float(config.timeout_sec or 20.0)))

        try:
            async with httpx.AsyncClient(timeout=timeout, proxy=proxy) as client:
                response = await client.post(self._endpoint(), json=payload, headers=headers)
        except httpx.TimeoutException:
            return f"搜索失败：请求 DeepSeek Search API 超时（{config.timeout_sec} 秒）。"
        except httpx.HTTPError as exc:
            return f"搜索失败：无法连接 DeepSeek Search API（{exc}）。"

        if response.status_code == 401:
            return "搜索失败：DeepSeek API Key 无效或已失效（401）。"
        if response.status_code == 402:
            return "搜索失败：DeepSeek 账户余额不足（402）。"
        if response.status_code == 429:
            return "搜索失败：请求过于频繁（429），请稍后重试。"
        if response.status_code >= 400:
            detail = self._truncate(response.text.strip(), 200)
            return f"搜索失败：DeepSeek Search API 返回 {response.status_code}：{detail}"

        try:
            data = response.json()
        except ValueError:
            return "搜索失败：DeepSeek Search API 返回了非 JSON 响应。"

        results = data.get("results") if isinstance(data, dict) else None
        if not results:
            return f"DeepSeek 联网搜索：{query}\n没有找到相关结果。"

        return self._format_results(query, results, with_content)

    def _format_results(self, query: str, results: list[Any], with_content: bool) -> str:
        """将官方返回的结果数组格式化为模型易读的文本。"""

        config = self.config.search
        lines = [f"DeepSeek 联网搜索：{query}", f"共 {len(results)} 条结果"]
        for index, item in enumerate(results, start=1):
            if not isinstance(item, dict):
                continue
            title = str(item.get("title") or "无标题").strip()
            url = str(item.get("url") or "").strip()
            site_name = str(item.get("site_name") or "").strip()
            date = str(item.get("date") or "").strip()[:10]
            digest = self._collapse(str(item.get("summary") or item.get("snippet") or ""))

            block = [f"{index}. {title}"]
            if url:
                block.append(f"   链接：{url}")
            meta = " | ".join(part for part in (site_name, date) if part)
            if meta:
                block.append(f"   来源：{meta}")

            content = self._collapse(str(item.get("content") or "")) if with_content else ""
            if content:
                block.append(f"   正文：{self._truncate(content, int(config.max_content_chars or 600))}")
            elif digest:
                block.append(f"   摘要：{self._truncate(digest, 300)}")
            lines.append("\n".join(block))

        return self._truncate("\n\n".join(lines), int(config.max_output_chars or 3000))

    @staticmethod
    def _collapse(text: str) -> str:
        """压缩多余空白，避免摘要中的换行打乱结果排版。"""

        return re.sub(r"\s+", " ", text).strip()

    @staticmethod
    def _truncate(text: str, limit: int) -> str:
        """按字符数截断文本，避免超出模型上下文。"""

        if limit <= 0 or len(text) <= limit:
            return text
        return text[:limit].rstrip() + "…（内容已截断）"


def create_plugin() -> DeepSeekSearchPlugin:
    """创建插件实例。"""

    return DeepSeekSearchPlugin()
