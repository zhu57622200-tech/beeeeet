<div align="center">

# 买定离手 beeeeet

### 口说无凭，下注为证。

**📦 你正在看「单机版」分支**（纯前端 · localStorage 本地对战 · 无需后端）｜联机版见 `main` 分支

**一个给熟人小圈玩的预测对赌游戏——比的是眼光和认知，不是运气。**
朋友之间对各种「会发生 / 不会发生」的事开盘对赌，纯虚拟积分、永不兑现真钱，
图的就是饭桌上、群里那口「我看得比你准」的不服气。

<br>

<img src="screenshots/01-login.png" width="23%" />
<img src="screenshots/02-matches.png" width="23%" />
<img src="screenshots/03-detail.png" width="23%" />
<img src="screenshots/04-rank.png" width="23%" />

<sub>登录 · 开盘对赌 · 下注与嘴炮 · 认知榜单</sub>

![license](https://img.shields.io/badge/license-MIT-blue) ![stack](https://img.shields.io/badge/Vue3-Vite-42b883) ![stack](https://img.shields.io/badge/Fastify-SQLite-000)

</div>

---

## ✨ 这是什么

每个熟人群里都有那种争论：「这球主队肯定赢」「老王这周末绝对脱单」「这币还得涨」……
**买定离手把这些口水仗变成一场场可量化的对赌**：你开个盘、定个赔率，朋友来接，到点揭晓，赢家通吃积分、上榜单、被群嘲或被膜拜。

- 🎯 **比眼光，不比运气**——下注的是你对真实世界的判断力。
- 💸 **纯虚拟积分，永不兑现**——零金钱风险，赢的是面子和认知优越感。
- 👥 **熟人小圈专属**——团码进群，30 人的饭桌江湖。

## 🎯 它的价值

| | |
|---|---|
| **对朋友圈** | 把无意义的吹牛和争论，沉淀成「谁的判断力更强」的长期战绩。赢一次嘴，不如赢一局盘。 |
| **对你自己** | 用虚拟积分逼真地训练判断与下注纪律——什么时候该 all-in，什么时候该认怂，眼光是可以练出来的。 |
| **作为工程** | 一套完整、自洽的全栈实现：实时对赌、权威结算、资金守恒、幂等防重复扣款。 |

## 🚀 不只是玩具——一个可深度改造的产品级骨架

这不是一次性的 demo，而是一套**已经在真实熟人圈跑起来、结构完整、可持续二次开发**的底座。它具备做成正经产品所需要的工程地基：

- **资金安全内核**：`SUM(用户余额 + 冻结) == SUM(系统账本)` 的守恒不变式贯穿每一笔动钱，配合 `X-Idempotency-Key` 幂等——这是任何「带账户和积分」的产品最难、也最该先打好的地基。
- **可扩展的玩法引擎**：约赌 / 坐庄 / 彩池 三种结算模型抽象在 `src/core/`（前后端共享纯函数），加新玩法只需扩展纯函数 + 一张表，不动核心。
- **权威结算 + 申诉**：服务端权威判定、揭晓裁定、争议申诉，已经考虑了多人博弈的真实摩擦。
- **双形态架构**：联机版（C/S 多人实时）与单机版（纯前端）同源，`src/core/` 复用，适配不同分发场景。
- **完整测试**：前后端含守恒回归用例，改动有安全网。

**想往哪改都有路**：换皮做成「体育竞猜社区」「预测市场」「公司内部 KPI 对赌」；接入真实身份/支付（注意各地博彩合规！）；扩展段位赛季、实时房间、AI 出题……骨架都接得住。**clone 下来就是一个能直接迭代成产品的起点。**

## 🎮 玩法

**🎲 真人对赌**（三种模式）
- **约赌**：1v1 开盘，你押一边、定赔率，朋友接对立面，到点揭晓赢家通吃。
- **坐庄**：你当庄家挂赔率收注，多人来押，封顶控制风险。
- **彩池**：多人投同一事件，赢方按比例瓜分输方的池子。

**📈 系统盘**：接入真实事件的市场参考概率（体育 / 加密 / 国际 / 财经 / 世界杯专区…），跟着大盘用积分押注。

**🤖 AI 开盘助手**：用大白话写个含糊的题，AI 帮你打磨成「怎么算赢、以什么为准、何时揭晓」的无歧义判定标准。

**🏆 社交竞技**：好友 / 私信 / **嘴炮评论** / 每日签到 / 赛季；四张榜单——**身家榜 · 神预测榜（胜率）· 连胜榜 · 老赖榜**；揭晓裁定 + 申诉机制。

## 🧠 设计理念

放大人「**比眼光、比认知**」的那股较劲心——把「我赢了」升华成「我比你更懂」。核心从来不是赌钱（永不兑现），而是**用可量化的战绩，证明你的判断力**。榜单排的不是积分，是认知。

## 🛠 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Vue 3 + Vite，纯 `reactive` 状态管理（无 Pinia） |
| 后端 | Fastify 5 + better-sqlite3，JWT 鉴权 |
| 共享 | `src/core/` 前后端共享纯函数（赔率 / 结算 / 段位 / 治理） |
| 形态 | **联机版**（`main` 分支，C/S 多人）+ **单机版**（`offline` 分支，纯前端本地对战） |

---

## 📦 下载 · 安装 · 部署 · 使用

> 环境要求：**Node.js ≥ 20**、npm。后端用 SQLite，无需单独装数据库。

### 0. 克隆

```bash
git clone https://github.com/zhu57622200-tech/beeeeet.git
cd beeeeet
```

### A. 只想快速试玩 → 单机版（最简单，纯前端）

单机版在 `offline` 分支，**不需要后端**，数据存浏览器 localStorage：

```bash
git checkout offline
npm install
npm run dev        # 本地开发预览
# 或 npm run build → 把 dist/ 丢到任意静态托管（Nginx / Vercel / GitHub Pages）即可
```

### B. 要多人联机 → 联机版（前端 + 后端）

**① 启动后端**

```bash
cd server
npm install

# 配置环境变量（在 server/ 下建 .env 或直接 export）：
#   JWT_SECRET=随便一串长随机字符串   （必填，签发登录 token）
#   DEEPSEEK_KEY=sk-xxxx              （可选，启用 AI 开盘助手；不填则降级为手动写判定）
export JWT_SECRET="$(openssl rand -hex 32)"

npm run bootstrap   # 首次建库：生成管理员账号 + 团码（控制台会打印初始密码，请记下）
npm start           # 后端听 127.0.0.1:8788
```

**② 启动前端**（另开一个终端，回到项目根目录）

```bash
npm install
# DeepSeek key 走前端代理注入：在项目根建 .env.local 写 DEEPSEEK_KEY=sk-xxxx（可选）
npm run dev         # 开发模式，已自动把 /api 代理到本地后端 8788
```

打开终端提示的本地地址 → 用团码注册账号即可开玩。

### C. 部署上线（生产，给朋友用）

```bash
# 1) 前端打包
npm run build       # 产出 dist/

# 2) 后端用 pm2 常驻（需 Node ≥ 20）
cd server && npm install --omit=dev
JWT_SECRET=... DEEPSEEK_KEY=... pm2 start index.js --name beeeeet

# 3) Nginx：托管 dist/ + 反代 /api 到后端，套 HTTPS（certbot）
```

一份最简 Nginx 参考（替换成你自己的域名/路径）：

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;
    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    root /var/www/beeeeet/dist;     # 前端 build 产物
    index index.html;

    location /api/ { proxy_pass http://127.0.0.1:8788; }   # 反代后端
    location / { try_files $uri $uri/ /index.html; }       # SPA 兜底
}
```

### 测试

```bash
npx vitest run         # 前端 + 共享逻辑
cd server && npm test  # 后端（含守恒回归用例）
```

---

## ⚠️ 免责声明

**纯虚拟积分娱乐项目，积分永不可兑现为任何真实货币或财物**，仅供熟人之间趣味对赌、锻炼判断力。若二次开发接入真实金钱/博彩，请务必遵守你所在地区的法律法规，风险自负。

## 📄 License

[MIT](./LICENSE) © 2026 beeeeet
