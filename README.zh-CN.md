# CRM BI · 客户经营与商业智能平台

[双语首页](README.md) · [English guide](README.en.md)

CRM BI 是一个使用 **Java 21、Spring Boot 3.5、Spring Security、Spring JDBC、HikariCP 和 PostgreSQL 18** 开发的客户经营与商业智能项目。它参考主流销售 CRM 的工作方式，把获客、销售推进、签约、订单、回款、客户服务和经营分析连接到同一套数据模型中。

## 已实现功能

| 模块 | 能力 |
| --- | --- |
| 角色驾驶舱 | 按角色装配菜单、KPI、统计图和报表；支持全部、部门、本人数据范围 |
| 客户 360 | 基本资料、联系人、跟进记录，以及线索 → 商机 → 合同 → 订单 → 回款的统一业务旅程 |
| 公海与线索池 | 潜在客户领取/退回，线索领取/分配，线索原子转化为客户和联系人 |
| 商机 | 列表与全量阶段看板、阶段金额、预计成交时间、逾期统计和阶段推进 |
| 合同、订单、回款 | 合同金额与成本、订单、分次回款、已收/待收汇总、超额回款保护 |
| 自助 BI | 报表分组、聚合、公式字段、筛选、分页、导出，以及 11 种 ECharts 统计图 |
| 指标与任务 | 12 个按独立业务口径计算的 T+1 指标、120 天回算、定时单日计算、滚动补算、归档检查和日志 |
| 系统管理 | 用户、角色、ACL 权限矩阵、数据库版本、连接池、索引、RLS、迁移和查询计划 |

界面使用橙色、莓粉、薄荷绿、紫色、蓝色和柠檬黄组成的多巴胺配色，并支持窄屏导航。

## 数据联动

客户 360 的 `journey` 接口使用 PostgreSQL `UNION ALL` 统一线索、商机、合同、订单、回款和跟进事件，再按发生时间排序。签约金额、订单金额、累计回款与待收金额均从关联业务表实时聚合。

指标任务不会复用一个占位数值。日销售额、本月累计销售额、合同数、订单金额、订单数、客单价、成交客户、新增客户、新增线索、线索转化数、转化率和毛利率分别执行自己的 SQL 口径，并写入 `bi_metric_value`。

## PostgreSQL 能力

- 普通运行角色 `crm_app` 没有超级用户或 `BYPASSRLS` 权限。
- Spring JDBC 事务通过 `set_config(..., true)` 设置用户、角色、部门和数据范围，事务结束后自动清除。
- RLS 覆盖客户、联系人、线索、商机、合同、订单、回款和跟进。
- 数据库序列生成业务编号，避免并发 `MAX + 1` 冲突。
- `crm_convert_lead()` 和行锁保证线索转化原子性。
- CHECK、外键和触发器在绕过 API 的直接 SQL 下仍阻止超额回款和非法金额。
- `pg_trgm` + GIN 支持包含搜索；JSONB 保存 BI 配置和变更审计。
- 物化视图、窗口函数和 advisory lock 用于经营趋势、累计值和并发刷新。

## 运行

准备 Node.js 22+、npm 和 Docker。Java 21 与 Maven 由 Docker 构建提供。

```sh
git clone https://github.com/Crazy4Lamb/crm-bi.git
cd crm-bi
npm ci
npm run setup
```

访问 [http://127.0.0.1:8787](http://127.0.0.1:8787)。首次运行会生成未纳入 Git 的 `.env`，启动独立 PostgreSQL 18，迁移和生成演示数据，再构建 Spring Boot 应用。重复执行只应用新迁移并保留已有业务数据。

常用演示账号：管理员 `admin / admin123`，总经理 `gm01 / 123456`，销售代表 `rep01 / 123456`，分析师 `ana01 / 123456`。

```sh
npm start          # 构建并启动 Java 应用
npm stop           # 停止 Compose 服务
npm run db:up      # 只启动数据库
npm run db:migrate # 应用增量迁移
npm run db:backup  # 生成 pg_dump 自定义格式备份
```

## 验证

```sh
npm test          # 66 项冒烟 + 37 项 CRM 流程和权限回归
npm run test:pg   # 31 项 PostgreSQL 专项回归
```

共 134 项检查覆盖 Spring Boot HTTP 接口、角色权限、RLS、连接复用、事务回滚、并发编号、原子转化、客户 360 数据联动、并发回款、独立指标口径、滚动补算、多值和日期筛选、物化视图、窗口函数、审计和真实查询计划。GitHub Actions 使用 Java 21 和独立 PostgreSQL 18 服务重复执行。

## 目录

```text
src/main/java/        Spring Boot 控制器、安全、数据库访问和业务服务
web/                  原生 JavaScript 与本地 ECharts
server/db/            数据库基线、增量迁移和种子数据工具
server/services/      仅用于初始化与历史回算的 Node 辅助代码
scripts/              安装、备份和端到端测试
Dockerfile            Java 21 多阶段镜像
compose.yaml          Spring Boot + PostgreSQL 18
```

Node.js 只用于建库、种子数据和黑盒回归；运行时 HTTP API 全部由 Spring Boot 提供。

![CRM BI 角色驾驶舱](docs/screenshots/dashboard.png)

![指标设计](docs/screenshots/metric-design.png)
