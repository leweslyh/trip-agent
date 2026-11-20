# 出行小助手 · DeepSeek × 高德开放平台

纯前端（零后端、零构建）的出行智能体。DeepSeek 负责理解意图与调度工具，高德开放平台负责真实地理数据。

## 功能

| 能力 | 实现 | 交互 |
| --- | --- | --- |
| 关键字搜索 | `AMap.PlaceSearch` / REST `place/text` | 地图打点 + 序号标记 / 静态图快照 |
| 周边搜索 | `PlaceSearch.searchNearBy` / REST `place/around` | 中心点脉冲标记 + 半径范围圈 / 静态图 |
| 路径规划 | `Driving / Walking / Riding / Transfer` | 路线折线 + 起终点标记 + 路线卡片（需 JS API Key） |
| 天气查询 | `AMap.Weather` / REST `weather/weatherInfo` | 左上角天气卡片（实时 + 未来三天） |
| 静态地图 | REST `staticmap` | 右下角图片快照卡片（可右键保存） |
| IP 定位 | REST `v3/ip`（无需安全密钥） | 有地图则打点，无地图则铺静态图 |
| 地理编码 | `AMap.Geocoder` / REST `geocode/geo` | 地址 → 经纬度并标注 |

两种 Key 都能跑：
- **只有「Web 服务」Key**：自动进入 **Web 服务模式**，IP 定位 / 天气 / 地理编码 / POI 搜索 / 静态地图全部走 `restapi.amap.com`（实测返回 `Access-Control-Allow-Origin: *`，前端可直接 `fetch`），位置用静态地图铺在占位区展示。
- **另有「Web 端（JS API）」Key**：升级为可拖拽交互地图 + 覆盖物 + 路径规划。

对话区会实时展示智能体的**工具调用轨迹**（调用了哪个工具、参数、结果摘要），便于观察 Agent 的工作过程。

## 快速开始

1. 准备 Key
   - **DeepSeek**：<https://platform.deepseek.com/api_keys> 创建 API Key（`sk-` 开头）。
   - **高德 · Web 服务**（推荐，必填一个）：<https://console.amap.com/dev/key/app> 创建应用后添加 Key，类型选「Web 服务」。用于 IP 定位、天气、地理编码、POI 搜索、静态地图。
   - **高德 · Web 端（JS API）**（可选）：再加一个 Key，类型选「Web 端 (JS API)」，同时会得到 **安全密钥 securityJsCode**（2021-12 之后申请必填）。只有它才能驱动可拖拽的交互地图与路径规划。

2. 启动一个静态服务器（`file://` 直开会导致 JS 模块与跨域请求异常）：

   ```bash
   cd liweiyue
   python3 -m http.server 5173
   # 浏览器访问 http://localhost:5173
   ```

3. 打开页面右上角「**API 设置**」，填入上面三个 Key，保存即可开始对话。

> 也可以把 Key 直接写进 `js/config.local.js`（本地开发用）；请勿将明文 Key 提交到仓库。
> 优先级：页面设置（localStorage）> `js/config.local.js` > `js/config.js` 的 DEFAULTS。

## 试试这些

- 帮我查一下杭州现在的天气和未来三天预报
- 搜索北京故宫博物院，并把结果显示在地图上
- 我在杭州西湖，帮我找附近 1 公里内的咖啡馆
- 规划从杭州东站到西湖风景区的驾车路线，给出距离和耗时
- 用 IP 定位看看我当前在哪个城市，再查一下天气
- 生成一张上海外滩的静态地图
- 从当前位置步行去最近的便利店

## 目录结构

```
index.html          页面骨架（对话区 + 地图区 + 设置弹窗）
css/style.css       深色玻璃拟态 UI、地图标记与卡片样式
js/config.js        配置读写（localStorage）、通用工具函数
js/amap.js          高德能力封装：加载 SDK、搜索、周边、路径、天气、定位、静态地图、图层渲染
js/tools.js         8 个 Function Calling 工具的定义与执行器
js/agent.js         DeepSeek 智能体循环（多轮 tool_calls → 结果回填 → 最终回答）
js/ui.js            对话渲染、Markdown、工具轨迹、地图卡片、Toast
js/app.js           启动与事件绑定
```

## 智能体工作流

```
用户提问
  └─> DeepSeek（携带 tools 定义）
        ├─ 返回 tool_calls ──> 本地执行高德工具 ──> 地图/卡片渲染
        │                        └─ 结果以 role=tool 回填
        └─ 再次请求模型 ……（最多 5 轮）
              └─> 最终中文回答（打字机效果）
```

可调用工具：`amap_search_places`、`amap_search_nearby`、`amap_plan_route`、`amap_weather`、`amap_static_map`、`amap_ip_location`、`amap_geocode`、`amap_clear_map`。

## 关键实现说明

- **REST 与 JS API 如何选择？** 每次调用先判断可用的插件：有 JS API 就优先用插件（可打点、画路线），没有或调用失败时回退到 `restapi.amap.com`（`/v3/ip`、`/v3/weather/weatherInfo`、`/v3/geocode/geo`、`/v3/place/text`、`/v3/place/around`）。实测 restapi 返回 `Access-Control-Allow-Origin: *`，前端 `fetch` 可用。
- **Key 类型自检**：启动时先用配置的 Key 请求一次 `restapi.amap.com/v3/ip`；如果成功，说明它是「Web 服务」Key，直接进入 Web 服务模式，不再尝试加载 JS API（避免拿错类型的 Key 反复报 `PLAT_NOMATCH`）。
- **静态地图 Key 类型**：必须是「Web 服务」类型；若只填 JS Key，图片会加载失败并在卡片中提示。
- **IP 定位精度**：城市级，用于在用户拒绝浏览器定位时兜底；`AMap.Geolocation` 成功时优先使用精确定位。
- **安全提示**：Key 保存在浏览器 localStorage，纯前端项目无法隐藏密钥，仅适合本地/内网/演示环境；生产环境请加一层后端代理。

## 常见问题

**地图区域一直显示「地图尚未加载」**
说明当前只有「Web 服务」Key（或 JS API Key 与安全密钥不匹配）。此时 IP 定位、天气、搜索、静态地图都已可用，占位区会展示定位静态图；若要可拖拽地图，请再补一个「Web 端（JS API）」Key 与安全密钥。

**提示 `INVALID_USER_KEY` / `PLAT_NOMATCH`**
Key 类型与接口不匹配：`webapi.amap.com`（JS API）只能用「Web 端」Key，`restapi.amap.com`（Web 服务）只能用「Web 服务」Key。

**DeepSeek 报 `Failed to fetch`**
网络无法直连 `api.deepseek.com`，或浏览器跨域被拦截。可在设置里把「接口地址」改为你自己的反向代理地址（需兼容 `/chat/completions` 路径）。

**静态地图显示「生成失败」**
未填写「Web 服务」类型的 Key，或该 Key 未开通静态地图权限。

**搜索没有结果**
中文地名建议带上城市；也可先用「IP 定位」确定城市后再搜索。
