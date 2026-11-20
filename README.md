# 🧭 出行小助手 · 纯前端智能体

基于 **DeepSeek-V4.1（deepseek-flash）** 与 **高德开放平台 Web 服务** 的纯前端出行智能体。无需后端、无需构建工具，双击或本地静态服务即可运行。

前三步的能力（对话 / 图片理解 / 语音输入 / 联网搜索）已全部融合进本版的「出行小助手」中。

## 快速开始

```bash
# 任选其一，在项目目录下启动静态服务器
python3 -m http.server 8000
# 或 npx serve .
```

浏览器打开 `http://localhost:8000`，允许定位权限即可。

> 建议用 localhost 访问：浏览器只在 **HTTPS / localhost** 下开放麦克风（`getUserMedia`）。
> 直接双击 `index.html`（file://）也能聊天和查地图，但语音录制会降级为浏览器内置识别。

Key 已在首次打开时预填（设置面板可改），只保存在本机 `localStorage`。

## 功能一览

| 能力 | 实现方式 | 说明 |
| --- | --- | --- |
| 对话 & 推理 | `POST https://api.deepseek.com/chat/completions` | SSE 流式输出，`reasoning_content` 折叠展示，可调 `reasoning_effort` |
| 图片输入 | `deepseek-flash` 多模态 | 选择/拖拽/粘贴图片，前端压缩到 1280px 后以 base64 发送 |
| 语音输入 | 硅基流动 `FunAudioLLM/SenseVoiceSmall` | MediaRecorder 录音 → `audio/transcriptions`；无 Key 时降级 Web Speech API |
| 联网搜索 | DeepSeek 原生 `deepseek_web_search` | 作为本地工具 `web_search` 触发子请求，正文右侧展示引用来源 |
| 网页抓取 | DeepSeek 原生 `deepseek_read_url` | 工具 `read_url`，读取指定链接正文并总结 |
| 天气查询 | 高德 `/v3/weather/weatherInfo` | 实时天气 + 未来 4 天预报，渲染天气卡片 |
| 关键字搜索 | 高德 `/v3/place/text` | 返回名称/地址/电话/坐标，并在右侧地图上标注 |
| 周边搜索 | 高德 `/v3/place/around` | 以当前定位（或指定坐标）为圆心，按距离排序 |
| 路径规划 | 高德 v3 driving / walking、v4 bicycling、v3 transit | 距离、耗时、过路费/票价、主要路段，路线自动画到地图上 |
| 交互式地图 | Leaflet + 高德瓦片 | 可拖动/缩放，标注点带气泡（名称、地址、距离），路线折线，支持点图选点后「搜这附近」 |
| 静态地图 | 高德 `/v3/staticmap` | 作为降级底图：Leaflet CDN 不可用时自动改用静态图 |
| IP 定位 | 高德 `/v3/ip` | 省市区 + 城市中心坐标；叠加浏览器精确定位与逆地理编码 |

## 目录结构

```
index.html            页面骨架（三栏：快捷能力 / 对话 / 行程画布）
assets/styles.css     设计系统：明暗双主题、卡片、气泡、响应式
assets/markdown.js    零依赖 Markdown 渲染（含 XSS 转义与链接白名单）
assets/amap.js        高德 SDK：多 Key 轮换、工具定义、结果归一化、地图数据载荷
assets/map.js         交互式地图：Leaflet + 高德瓦片，标注/折线/选点，静态图降级
assets/deepseek.js    DeepSeek 接口层：流式解析、工具回环、原生搜索/抓取、语音转写
assets/app.js         UI 交互：消息流、图片压缩、录音、设置、卡片与地图渲染
```

## 智能体工作方式

1. 每轮对话把「系统提示 + 历史消息 + 当前定位」发送给 DeepSeek，并附带工具清单。
2. 模型返回 `finish_reason = tool_calls` 时，前端本地执行对应工具（高德 HTTP 接口 / DeepSeek 联网子请求）。
3. 工具结果以 `role: tool` 回填，最多 6 轮，直到模型给出最终自然语言回答。
4. 工具的结构化结果同时被 UI 消费：POI 列表、路线卡片、天气卡片写入右侧「结果」，地图数据写入「地图」并渲染为可交互地图。

### 关于「DeepSeek 自带搜索」

`deepseek_web_search` / `deepseek_read_url` 是 DeepSeek V4.1 的服务端内置工具。
实测发现：当同一次请求里还声明了需要前端回填结果的本地函数（高德工具）时，工具调用回填后模型不再触发服务端搜索。
因此本实现把二者拆开——主对话只挂本地工具，`web_search` / `read_url` 内部再用**服务端内置工具**发起一次子请求并回传摘要与引用。既保证稳定触发，也保留了原生搜索/抓取的时效性。

## Key 与安全说明

- 三个 Key 全部在浏览器端直连官方接口，不经过任何第三方服务器。
- 前端代码中的 Key 仅作教学演示的默认值，**生产环境请移除**并改为用户自填（设置面板即为此设计）。
- 高德两个 Key 组成轮换池：遇到 `INVALID_USER_KEY` / 配额类错误自动切换下一个。
- 清除本机密钥：设置面板 →「清除已保存密钥」。

## 调试小贴士

- 地图空白：交互地图依赖 Leaflet（jsdelivr / unpkg CDN）与高德瓦片服务；若 CDN 不可达会自动退成高德静态图，静态图也失败则检查 Key 是否开通「静态地图」权限。
- 语音不可用：确认是 `localhost`/HTTPS 访问并已授权麦克风；硅基流动 Key 无效时会自动降级浏览器识别。
- 回答不含工具结果：检查左侧「能力状态」中的高德/联网是否为绿点，或在设置中打开对应开关。
