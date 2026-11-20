# 出行小助手智能体

基于 **DeepSeek 大模型** 与 **高德开放平台** 的纯前端出行智能助手。用户用自然语言表达出行需求，智能体通过 DeepSeek 的 Function Calling 能力自主决策、调用高德接口获取真实数据，并在浏览器端完成地图呈现。**无需任何后端服务**。

## 功能特性

| 功能 | 说明 |
| --- | --- |
| 🔍 关键字搜索 | 通过 `place/text` 搜索 POI 地点 |
| 📍 周边搜索 | 通过 `place/around` 在指定坐标附近搜索 |
| 🚗 路径规划 | 驾车 / 步行 / 公交三种方式（`direction` 接口） |
| 🌤️ 天气查询 | 实况天气（base）与多日预报（all） |
| 🗺️ 静态地图 | 通过 `staticmap` 接口生成带标注/折线的地图 |
| 🛰️ IP 定位 | 通过 `ip` 接口获取当前设备位置 |

## 目录结构

```
MMY/
├── index.html        # 页面骨架
├── css/style.css     # 样式与响应式适配
├── js/
│   ├── config.js     # API Key 配置管理（localStorage 持久化）
│   ├── amap.js       # 高德 Web服务 API 封装 + 静态地图构造
│   ├── agent.js      # DeepSeek 智能体工具调用循环
│   └── app.js        # UI 交互与结果渲染
└── README.md
```

## 快速开始

### 1. 获取 API Key

- **DeepSeek API Key**：前往 [DeepSeek 开放平台](https://platform.deepseek.com/) 注册并创建 API Key（`sk-...`）。
- **高德 Web服务 Key**：前往 [高德开放平台](https://lbs.amap.com/) → 控制台 → 应用管理 → 创建应用 → 添加 Key，**服务平台选择「Web服务」**。

### 2. 运行

本项目为纯静态页面，任选其一：

```bash
# 方式一：直接双击 index.html 打开（推荐本地体验）
# 方式二：使用任意静态服务器
python3 -m http.server 8080
# 然后浏览器访问 http://localhost:8080
```

打开页面后，点击右上角 ⚙️，填入两个 Key 即可使用。

### 3. 关于浏览器跨域（CORS）

> **重点说明**：高德 Web服务 API 已开启 CORS，可直接从浏览器调用。但 **DeepSeek 官方接口未对浏览器开放 CORS**，直连会被浏览器拦截（报 `No 'Access-Control-Allow-Origin' header`）。

因此需通过「CORS 代理」解决。两种方案任选：

**方案 A：使用公共 CORS 代理**（最简单）

在设置页「CORS 代理前缀」中填写，例如：

```
https://corsproxy.io/?url=
```

请求时会自动拼接为 `代理前缀 + encodeURIComponent(真实地址)`，代理会转发 POST 请求及 `Authorization` 头。

> ⚠️ 公共代理可能限流、不稳定，且你的 Key 会经过第三方服务器，仅建议个人/演示使用。

**方案 B：自建轻量代理**（更稳定、更安全）

任意支持转发 POST 的代理均可。以下是一个极简 Node 代理示例（仅 10 行，非业务后端，只做透明转发）：

```js
// proxy.mjs
import http from 'http';
import https from 'https';

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' });
    return res.end();
  }
  const p = https.request('https://api.deepseek.com' + req.url, { method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, { ...r.headers, 'Access-Control-Allow-Origin': '*' });
    r.pipe(res);
  });
  req.pipe(p);
}).listen(8787, () => console.log('proxy on :8787'));
```

```bash
node proxy.mjs
```

然后在设置页「CORS 代理前缀」填写 `http://localhost:8787/`（注意以 `/` 结尾，拼接的是 `chat/completions` 路径，而非完整 URL；由于自建代理可直接透传路径，请把「DeepSeek 接口地址」保持默认，并在代码中按需调整拼接逻辑）。

> 提示：当前版本代理前缀拼接的是「完整 URL」。若使用上述透传路径式自建代理，可将 `DeepSeek 接口地址` 设为 `http://localhost:8787` 并保持代理前缀留空，同样可工作。

### 4. 安全提醒

纯前端应用无法隐藏 API Key（Key 会出现在浏览器请求与源码中）。请：

- 仅使用有额度限制的 Key；
- 高德 Key 建议在控制台绑定调用来源/加白名单；
- 不要将含真实 Key 的页面部署到公网。

## 使用示例

- 「帮我搜索一下北京故宫的位置」
- 「我想在当前位置周边找咖啡店」
- 「帮我规划从天安门到鸟巢的驾车路线」
- 「北京今天天气怎么样？」
- 「在地图上展示天安门的位置」
- 「帮我定位一下我当前的 IP 位置」

也可直接点击顶部快捷按钮体验各功能。

## 实现原理

1. 用户输入自然语言 → 拼接系统提示词与对话历史 → 调用 DeepSeek `chat/completions`（携带 `tools` 定义）。
2. DeepSeek 返回 `tool_calls` → 前端执行对应高德接口 → 将结果以 `role: tool` 回传。
3. 循环上述过程（最多 6 轮），直至 DeepSeek 给出最终自然语言回答。
4. 前端根据工具调用记录，渲染文本回答 + 静态地图/POI 列表/路线/天气卡片。
