# Hospital Guide Agent

某医院 H5 导诊 Agent 技术演示。本地完成开发与测试，最终部署到已配置的云服务器。本项目未与医院建立合作，不代表医院官方服务；公开资料来源在页面底部说明。

## 目录

```text
assets/maps/                    医院室内地图包
contracts/                      可替换端口与 TypeScript 契约
deploy/                         Nginx、systemd、PostgreSQL 部署配置
docs/                           本地计划、说明和服务器记录（Git 忽略）
examples/                       Schema 正反例和语义校验样例
knowledge/                      官网、项目整理和地图离线知识库
schemas/                        JSON Schema 业务契约
scripts/                        数据采集、构建和校验脚本
vendor/fengmap-js-sdk-v3.2.0/   第三方蜂鸟地图 SDK
apps/server/                    Node 标准库后端、SQLite 适配器与业务服务
apps/web/                       患者端、地图与医生工作台前端
tests/                          端到端业务测试
```

`docs/` 包含本地规划和敏感服务器记录，不进入 Git。任何 API Key、SSH 信息或数据库密码都不得写入源码、前端构建包或日志。

## 当前状态

- 业务契约覆盖实名患者档案、医生账号与出诊、号源、挂号、接诊关系、版本化病历、审计、医嘱、线下缴费账单及明确标记的模拟设备结果。
- 离线知识库已包含医院公开信息、完整科室目录、医生公开参考资料和地图地点索引。
- 医院业务系统可在 localhost 启动，并已部署到云服务器。
- 新需求基线已确定：患者免登录实名建档、医生注册登录、出诊设置、可编辑病历，以及仅设备/实物限制对象可模拟。
- PostgreSQL 已应用 `002_current_business_model`；新增 `003_doctor_employee_number_login` 将医生登录标识统一为六位工号，部署时应通过既有迁移脚本顺序应用。
- 生产运行使用 PostgreSQL `runtime` Schema 适配层（迁移 `005_runtime_schema`）；本地默认继续使用 SQLite，业务服务接口保持一致。

详细业务口径见本地文档 `docs/需求基线.md`。`docs/` 被 Git 忽略，不应作为构建时运行依赖。

## 本地启动

运行时统一使用 `hospital-agent` Conda 环境：

```powershell
conda activate hospital-agent
npm start
```

浏览器访问 `http://127.0.0.1:3000`。也可以直接运行：

```powershell
conda run --no-capture-output -n hospital-agent npm start
```

首次运行会在 `.local/` 生成 SQLite 数据库、AES 加密密钥和医生审核码，这些文件均被 Git 忽略。医生以六位院内工号作为唯一登录标识，密码至少 8 位并只保存为哈希。

医生注册默认进入 `PENDING_REVIEW`，不能直接登录。系统首次使用时在管理员页面初始化唯一管理员；管理员登录后审核并激活医生账号。审核操作写入审计记录，不使用本地 CLI 审核码，也不代表医院已经完成人事核验。

只读检查本地运行库中的业务数据数量：

```powershell
conda run --no-capture-output -n hospital-agent npm run runtime:counts
```

90872 地图在独立 `/map` 页面通过蜂鸟 JavaScript SDK v3 在线加载：初始化传入 `mapID: "90872"` 和 `tile: false`，不配置本地 `mapURL`。Agent 在地点或路线意图后提供地图入口；页面按地图 FID 解析真实坐标，并使用人行导航分析器绘制路线，地图服务不可用时降级为简短楼层指引。`assets/maps/90872.fmap` 仅用于离线提取地点、楼层和路线知识，不作为 v3 SDK 的浏览器渲染资源。服务默认从被 Git 忽略的 `docs/APIConfigs.txt` 的“蜂鸟SDK”段读取 `appName`、`mapID` 和 `APIKey`；`AccessKey`、`SecretKey` 不会发送给浏览器。也可用 `FENGMAP_APP_NAME`、`FENGMAP_MAP_ID` 和 `FENGMAP_KEY` 环境变量覆盖。蜂鸟 v3 地图数据解码依赖动态函数，因此当前页面 CSP 对本地受信任 SDK 允许 `unsafe-eval`；其余脚本来源仍限制为本站。

患者对话支持讯飞方言识别与超拟人语音合成。浏览器将麦克风音频降采样为 16 kHz、16 bit、单声道 PCM，以 1280 字节/40 ms 分帧实时送往讯飞；最长录音 60 秒，识别文字只写入输入框，仍由患者确认后发送。模型即时回复及候诊主动消息默认自动朗读，患者可在对话页顶部关闭，偏好保存在浏览器中。服务从 `docs/APIConfigs.txt` 的“讯飞方言识别大模型”和“讯飞超拟人语音合成大模型”段读取凭据；APISecret 与 APIPassword 不会由配置接口下发。语音识别使用短时签名直连，合成由服务端代理并以 MP3 返回。可用 `XFYUN_IAT_*`、`XFYUN_TTS_*` 环境变量覆盖配置。

## 校验

```powershell
conda run --no-capture-output -n hospital-agent npm test
conda run -n hospital-agent python .\scripts\validate_contracts.py
conda run -n hospital-agent python .\scripts\validate_knowledge_base.py
```

Node 测试数据只写入系统临时目录，并在测试完成后删除。
