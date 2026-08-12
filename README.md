# Hospital Guide Agent

绵阳市中心医院 H5 导诊 Agent。本地完成开发与测试，最终部署到已配置的云服务器。

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
tests/                          第二阶段端到端业务测试
```

`docs/` 包含本地规划和敏感服务器记录，不进入 Git。任何 API Key、SSH 信息或数据库密码都不得写入源码、前端构建包或日志。

## 当前状态

- 阶段 0 契约已按最新需求同步：实名患者档案、医生账号与出诊、号源、挂号、接诊关系、版本化病历、审计、医嘱、线下缴费账单及明确标记的模拟设备结果。
- 阶段 1 离线知识库已完成。
- 阶段 2 最小可运行医院业务系统已完成，可在 localhost 启动。
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

医生注册默认进入 `PENDING_REVIEW`，不能直接登录。系统首次使用时在管理员页面初始化唯一管理员；管理员登录后审核并激活医生账号。审核操作写入审计记录，不使用本地 CLI 审核码，也不代表绵阳市中心医院已经完成人事核验。

只读检查本地运行库中的业务数据数量：

```powershell
conda run --no-capture-output -n hospital-agent npm run runtime:counts
```

90872 地图的本地数据和 SDK 已接入。地图包按 `/map-data/90872/90872.fmap` 提供，前端使用蜂鸟 SDK 的 `mapURLAbsolute` 单文件模式加载。服务默认从被 Git 忽略的 `docs/APIConfigs.txt` 的“蜂鸟SDK”段读取 `appName`、`mapID` 和 `APIKey`；`AccessKey`、`SecretKey` 不会发送给浏览器。也可用 `FENGMAP_APP_NAME`、`FENGMAP_MAP_ID` 和 `FENGMAP_KEY` 环境变量覆盖。配置的 `mapID` 必须与本地地图包一致，即 `90872`。

## 校验

```powershell
conda run --no-capture-output -n hospital-agent npm test
conda run -n hospital-agent python .\scripts\validate_contracts.py
conda run -n hospital-agent python .\scripts\validate_phase1_knowledge.py
```

Node 测试数据只写入系统临时目录，并在测试完成后删除。
