# 出行小助手 · DeepSeek × 高德开放平台

纯前端（无后端、无构建）的出行智能体：DeepSeek 大模型负责理解意图并自主调用工具，高德开放平台 Web 服务 API 负责真实地图数据，结果以「对话 + 工具卡片 + 静态地图」三合一呈现。

## 功能

| 能力 | 实现接口 | 说明 |
| --- | --- | --- |
| 关键字搜索 | `/v3/place/text` | 关键词 + 城市限定检索 POI，返回地址、电话、类型 |
| 周边搜索 | `/v3/place/around` | 以坐标为中心按半径查找，未给坐标时自动 IP 定位 |
| 路径规划 | `/v3/direction/driving`、`/v3/direction/walking`、`/v4/direction/bicycling`、`/v3/direction/transit/integrated` | 驾车 / 步行 / 骑行 / 公交，输出距离、耗时、打车费、换乘方案 |
| 天气查询 | `/v3/weather/weatherInfo` | 实况 + 未来 4 天预报，城市名自动转 adcode |
| 静态地图 | `/v3/staticmap` | 标注点 + 路线折线一次性出图，自动按包围盒居中和缩放 |
| IP 定位 | `/v3/ip` + `/v3/geocode/regeo` | 无浏览器定位权限也能识别城市与大致位置 |

另外内置地理编码 `/v3/geocode/geo` 与逆地理编码 `/v3/geocode/regeo`，用于把地名转成坐标。

## 目录

```
index.html          页面结构（对话区 / 静态地图侧栏 / 设置弹窗）
assets/style.css    样式
js/amap.js          高德请求层（fetch → JSONP → 代理）、工具函数、地理编码、搜索
js/amap-ext.js      路径规划、天气、IP 定位、静态地图 URL 构造
js/ui.js            消息气泡、工具卡片、地图面板渲染
js/agent.js         DeepSeek 客户端、工具（function calling）定义、智能体循环
js/app.js           工具执行、会话管理、定位、设置
```

## 快速开始

1. **高德 Key**：登录 [高德开放平台控制台](https://console.amap.com/dev/key/app) → 创建应用 → 添加 Key → 服务平台选择 **Web 服务**（不是 Web 端 JS API）。
2. **DeepSeek Key**：在 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 创建 API Key。
3. **启动**（任选其一）：
   ```bash
   python3 -m http.server 5173      # 然后访问 http://localhost:5173
   # 或者 npx serve .
   ```
   直接双击 `index.html` 也能打开，但部分浏览器会以 `file://` 作为来源，跨域请求更容易被拦截，建议用本地服务器。
4. 打开页面 → 右上角「设置」→ 填入两个 Key → 保存。Key 只存在浏览器 `localStorage`，不会上传到任何服务器。

## 关于跨域

实测高德 `restapi.amap.com` 的响应头已包含 `Access-Control-Allow-Origin: *`，DeepSeek 接口的预检响应也允许浏览器携带 `Authorization` 请求，因此**默认无需任何代理**，纯前端可直接跑通。

为应对内网代理、企业网关等特殊环境，请求层仍保留三级兜底：

1. 直接 `fetch`；
2. 失败后自动尝试 JSONP（高德支持 `callback` 参数）；
3. 仍失败则使用「设置 → 跨域代理」里填写的前缀，支持 `{url}` 占位，例如
   `https://your-proxy.example.com/?url={url}`。

调用成功的通道会记在 `localStorage`，后续请求优先复用。若卡片提示「跨域请求被拦截」，再填代理即可。

DeepSeek 接口默认 `https://api.deepseek.com`，需要中转时可在「接口地址」改成兼容 OpenAI 协议的网关地址。模型请使用 `deepseek-chat`：`deepseek-reasoner` 目前不支持 function calling，无法驱动工具。

## 对话示例

- 「帮我搜索北京南锣鼓巷附近的咖啡馆」
- 「我现在在哪？顺便看看今天天气」
- 「从北京西站到首都机场 T3 怎么走？给我驾车和地铁两个方案」
- 「找找西湖附近 1 公里的酒店，并在地图上标出来」
- 「把天安门、故宫、景山公园标在同一张地图上」

## 智能体工作机制

`js/agent.js` 中用 OpenAI 兼容的 `tools` 声明 8 个工具，`run()` 循环执行：

```
用户消息 → 模型（stream）→ 若有 tool_calls → 逐个执行高德接口 → 结果回填 role=tool
        → 继续请求模型 → …（最多 6 轮）→ 输出最终中文回答
```

- 流式输出：`delta.content` 逐字上屏，`delta.tool_calls` 按 `index` 累积分片参数；
- 工具结果双通道：完整数据用于渲染卡片与静态地图，精简后的数据（去掉折线、限制 POI 条数）回填给模型，避免上下文过长；
- 每次请求都重新生成 system prompt，携带当前城市与坐标，模型因此知道「附近」指哪里；
- 搜索 / 路线 / 定位成功后自动重绘右侧静态地图，并用高德 URI 生成「高德打开」跳转链接。

## 注意事项

- 高德 Key 有每日配额，静态地图、路径规划分别计费，请勿高频轮询。
- 静态地图单张最大 `1024*1024`，本项目用 `750*460` + `scale=2`；折线会按 85 点抽样以控制 URL 长度。
- 公交规划需要城市信息，工具会自动用起点的逆地理编码补全。
- IP 定位精度只到城市/区级，返回的坐标是城市范围中心点，仅用于「附近」搜索的默认圆心。
- 所有 API Key 都在浏览器端，请勿把该页面直接部署为公开服务，或换成自己的后端中转并做鉴权限流。
