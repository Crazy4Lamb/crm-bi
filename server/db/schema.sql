-- ============================================================================
--  CRM + BI 分析平台  数据库结构 (PostgreSQL)
--  分区：1) 系统与权限  2) CRM 业务域  3) 报表引擎  4) 指标与统计图  5) 任务调度
-- ============================================================================

-- ---------------------------------------------------------------- 1. 系统与权限

create table sys_role (
  code        varchar(32) primary key,
  name        varchar(64)  not null,
  description varchar(255),
  sort_no     int default 0
);
comment on table sys_role is '角色';

create table sys_user (
  id            serial primary key,
  username      varchar(64)  not null unique,
  password      varchar(128) not null,
  real_name     varchar(64)  not null,
  role_code     varchar(32)  not null references sys_role(code),
  dept          varchar(64),
  phone         varchar(32),
  email         varchar(64),
  data_scope    varchar(16) default 'self',   -- all=全部  dept=本部门  self=仅本人
  status        char(1) default '1',          -- 1 启用 0 停用
  last_login_at timestamp,
  created_at    timestamp default now()
);
comment on table sys_user is '用户';
comment on column sys_user.data_scope is '数据范围：all/dept/self';

create table sys_menu (
  code        varchar(48) primary key,
  parent_code varchar(48),
  name        varchar(64) not null,
  path        varchar(64),
  icon        varchar(32),
  sort_no     int default 0
);
comment on table sys_menu is '菜单字典';

create table sys_acl (
  id       serial primary key,
  role_code varchar(32) not null,
  res_type varchar(16) not null,   -- menu / action / card / report / chart / dashboard
  res_key  varchar(64) not null,
  unique (role_code, res_type, res_key)
);
comment on table sys_acl is '角色资源授权（菜单/按钮/卡片/报表/图表）';

create table sys_oper_log (
  id         bigserial primary key,
  user_id    int,
  username   varchar(64),
  action     varchar(32),
  res_type   varchar(32),
  res_key    varchar(64),
  detail     text,
  created_at timestamp default now()
);

-- ---------------------------------------------------------------- 2. CRM 业务域

create table crm_customer (
  id           serial primary key,
  cust_no      varchar(32)  not null unique,
  name         varchar(128) not null,
  short_name   varchar(64),
  industry     varchar(32),          -- 制造/金融/医疗/教育/互联网/政府/能源
  region       varchar(32),          -- 华东/华北/华南/华中/西南/西北/东北
  level        varchar(8),           -- A/B/C/D
  source       varchar(32),          -- 官网/展会/转介绍/广告/陌拜/线上活动
  status       varchar(16),          -- potential 潜在 / active 成交 / inactive 流失
  credit_limit numeric(14,2) default 0,
  owner_id     int references sys_user(id),
  owner_dept   varchar(64),
  phone        varchar(32),
  email        varchar(64),
  address      varchar(255),
  remark       text,
  created_at   timestamp default now(),
  updated_at   timestamp default now()
);
create index idx_customer_owner on crm_customer(owner_id);
create index idx_customer_created on crm_customer(created_at);

create table crm_contact (
  id          serial primary key,
  customer_id int not null references crm_customer(id) on delete cascade,
  name        varchar(64) not null,
  position    varchar(64),
  phone       varchar(32),
  email       varchar(64),
  is_primary  boolean default false,
  created_at  timestamp default now()
);

create table crm_lead_pool (
  id          serial primary key,
  code        varchar(32) not null unique,
  name        varchar(64) not null,
  description varchar(255),
  rule_json   jsonb default '{}'::jsonb,   -- 分配规则：轮询/按区域/按行业
  capacity    int default 500,
  status      char(1) default '1',
  owner_id    int references sys_user(id),
  created_at  timestamp default now()
);
comment on table crm_lead_pool is '线索池';

create table crm_lead (
  id            serial primary key,
  lead_no       varchar(32) not null unique,
  name          varchar(64) not null,
  company       varchar(128),
  phone         varchar(32),
  wechat        varchar(64),
  industry      varchar(32),
  region        varchar(32),
  source        varchar(32),
  stage         varchar(16),        -- new 新线索/following 跟进中/qualified 已确认/converted 已转客户/invalid 无效
  intent_level  varchar(8),         -- 高/中/低
  est_amount    numeric(14,2) default 0,
  pool_id       int references crm_lead_pool(id),
  owner_id      int references sys_user(id),
  owner_dept    varchar(64),
  in_pool       boolean default true,
  claim_time    timestamp,
  customer_id   int references crm_customer(id),
  converted_at  timestamp,
  last_follow_at timestamp,
  created_at    timestamp default now(),
  updated_at    timestamp default now()
);
create index idx_lead_owner on crm_lead(owner_id);
create index idx_lead_pool on crm_lead(pool_id);

create table crm_opportunity (
  id           serial primary key,
  opp_no       varchar(32) not null unique,
  name         varchar(128) not null,
  customer_id  int references crm_customer(id),
  lead_id      int references crm_lead(id),
  stage        varchar(16),         -- 初步接洽/需求确认/方案报价/商务谈判/赢单/输单
  est_amount   numeric(14,2) default 0,
  win_rate     int default 0,
  expect_date  date,
  owner_id     int references sys_user(id),
  owner_dept   varchar(64),
  created_at   timestamp default now(),
  closed_at    timestamp
);

create table crm_contract (
  id          serial primary key,
  contract_no varchar(32) not null unique,
  name        varchar(128) not null,
  customer_id int references crm_customer(id),
  opp_id      int references crm_opportunity(id),
  amount      numeric(14,2) not null default 0,
  cost        numeric(14,2) not null default 0,
  tax_rate    numeric(6,4) default 0.06,
  sign_date   date not null,
  start_date  date,
  end_date    date,
  status      varchar(16),          -- draft 草稿/approving 审批中/effective 生效/closed 已完结/void 作废
  pay_type    varchar(16),          -- 一次性/分期/年付
  owner_id    int references sys_user(id),
  owner_dept  varchar(64),
  created_at  timestamp default now(),
  updated_at  timestamp default now()
);
create index idx_contract_sign on crm_contract(sign_date);
create index idx_contract_owner on crm_contract(owner_id);

create table crm_order (
  id          serial primary key,
  order_no    varchar(32) not null unique,
  contract_id int references crm_contract(id),
  customer_id int references crm_customer(id),
  product     varchar(64),          -- 产品线
  quantity    int default 1,
  amount      numeric(14,2) not null default 0,
  cost        numeric(14,2) not null default 0,
  discount    numeric(6,4) default 0,
  status      varchar(16),          -- pending 待付款/paid 已付款/delivered 已交付/done 已完成/refund 已退款
  order_date  date not null,
  pay_date    date,
  owner_id    int references sys_user(id),
  owner_dept  varchar(64),
  created_at  timestamp default now()
);
create index idx_order_date on crm_order(order_date);
create index idx_order_owner on crm_order(owner_id);

create table crm_payment (
  id          serial primary key,
  order_id    int not null references crm_order(id) on delete cascade,
  amount      numeric(14,2) not null default 0,
  pay_date    date not null,
  method      varchar(16),          -- 对公转账/支票/承兑汇票/在线支付
  remark      varchar(255),
  owner_id    int references sys_user(id),
  created_at  timestamp default now()
);
create index idx_payment_order on crm_payment(order_id);
comment on table crm_payment is '订单回款记录（参考纷享销客订单及回款管理）';

create table crm_follow_up (
  id         serial primary key,
  biz_type   varchar(16) not null,   -- customer / lead / opportunity / contract
  biz_id     int,
  content    varchar(500),
  way        varchar(16),            -- 电话/拜访/微信/邮件
  result     varchar(32),            -- 有意向/需跟进/已拒绝/已成交
  next_time  timestamp,
  owner_id   int references sys_user(id),
  created_at timestamp default now()
);
create index idx_follow_biz on crm_follow_up(biz_type, biz_id);

-- ---------------------------------------------------------------- 3. 报表引擎

create table rpt_dataset (
  id          serial primary key,
  code        varchar(48) not null unique,
  name        varchar(64) not null,
  base_table  varchar(64) not null,
  base_alias  varchar(16) default 't',
  joins       jsonb default '[]'::jsonb,   -- [{"type":"left","table":"crm_customer","alias":"c","on":"c.id = t.customer_id"}]
  date_field  varchar(48),                 -- 默认日期字段（数据集字段 key）
  owner_field varchar(48),                 -- 数据归属人字段 key，用于按角色数据范围过滤
  dept_field  varchar(48),                 -- 数据归属部门字段 key
  description varchar(255),
  status      char(1) default '1',
  created_at  timestamp default now()
);
comment on table rpt_dataset is '报表数据集（物理表 + 预置 join）';

create table rpt_dataset_field (
  id           serial primary key,
  dataset_id   int not null references rpt_dataset(id) on delete cascade,
  field_key    varchar(64) not null,
  field_name   varchar(64) not null,
  field_type   varchar(16) not null,   -- string/number/date/datetime/bool
  field_role   varchar(16) not null,   -- dimension 维度 / measure 度量
  expr         varchar(255) not null,  -- SQL 表达式，可带别名，如 c.name / t.amount
  enum_options varchar(400),
  sort_no      int default 0,
  unique (dataset_id, field_key)
);
comment on column rpt_dataset_field.expr is '白名单 SQL 表达式，查询构建器只允许使用此处登记的表达式';

create table rpt_report (
  id          serial primary key,
  code        varchar(48) not null unique,
  name        varchar(64) not null,
  category    varchar(32),          -- 销售/客户/产品/财务/线索
  dataset_id  int not null references rpt_dataset(id),
  description varchar(255),
  owner_id    int references sys_user(id),
  status      char(1) default '1',
  is_public   boolean default true,
  created_at  timestamp default now(),
  updated_at  timestamp default now()
);

create table rpt_report_field (
  id          serial primary key,
  report_id   int not null references rpt_report(id) on delete cascade,
  field_key   varchar(64) not null,     -- 报表内逻辑键
  field_name  varchar(64) not null,     -- 显示名（可覆盖数据集字段名）
  field_type  varchar(16) not null,
  field_role  varchar(16) not null,     -- dimension / measure
  dataset_field_key varchar(64),        -- 引用数据集字段；自定义字段为空
  agg_fn      varchar(16) default 'none',-- none/count/count_distinct/sum/avg/max/min
  custom_expr varchar(255),             -- 自定义字段公式，引用其它报表字段 key
  is_group_by boolean default false,
  is_show     boolean default true,
  is_custom   boolean default false,
  sort_dir    varchar(8) default 'none',-- asc/desc/none
  fmt         varchar(24),              -- 数值格式：number/percent/currency
  width       int default 140,
  sort_no     int default 0,
  unique (report_id, field_key)
);
comment on column rpt_report_field.agg_fn is '统计方式：none 不聚合 / sum 求和 / count 计数 / avg 平均 / max / min / count_distinct 去重计数';

create table rpt_report_filter (
  id          serial primary key,
  report_id   int not null references rpt_report(id) on delete cascade,
  field_key   varchar(64) not null,
  op          varchar(16) not null,   -- eq/ne/gt/ge/lt/le/like/in/between/isnull/notnull
  value       varchar(255),
  value2      varchar(255),
  logic       varchar(8) default 'and',
  sort_no     int default 0
);

-- ---------------------------------------------------------------- 4. 指标与统计图

create table bi_metric (
  id             serial primary key,
  code           varchar(48) not null unique,
  name           varchar(64) not null,
  metric_group   varchar(32),              -- 销售/客户/线索/财务
  report_id      int references rpt_report(id),
  measure_key    varchar(64),              -- 报表度量字段 key；为空表示计行数
  agg_fn         varchar(16) not null default 'sum',  -- sum/count/count_distinct/avg/max/min
  date_field_key varchar(64),              -- 日期字段（按天统计，T+1）
  date_mode      varchar(16) default 'day',-- day 当日 / mtd 本月累计 / month 整月 / last7 / last30
  filters        jsonb default '[]'::jsonb,-- 附加过滤 [{fieldKey,op,value}]
  unit           varchar(16),              -- 元/个/%/天
  precision      int default 0,
  direction      varchar(8) default 'up',  -- 越大越好 up / 越小越好 down
  description    varchar(255),
  owner_id       int references sys_user(id),
  status         char(1) default '1',
  created_at     timestamp default now(),
  updated_at     timestamp default now()
);
comment on table bi_metric is '指标定义：从报表数据聚合而来，按 T+1 计算';

create table bi_metric_value (
  id          bigserial primary key,
  metric_id   int not null references bi_metric(id) on delete cascade,
  stat_date   date not null,
  value       numeric(20,4) default 0,
  prev_value  numeric(20,4),
  calc_time   timestamp default now(),
  task_log_id bigint,
  unique (metric_id, stat_date)
);
create index idx_metric_value_date on bi_metric_value(stat_date);

create table bi_widget (
  id             serial primary key,
  code           varchar(48) not null unique,
  name           varchar(64) not null,
  widget_type    varchar(16) not null,     -- card 卡片 / chart 统计图 / table 明细表
  chart_type     varchar(16),              -- bar/bar_h/line/area/pie/doughnut/scatter/heatmap/funnel/radar/gauge
  value_mode     varchar(16) default 'direct', -- card: metric 取指标 / direct 实时聚合
  metric_id      int references bi_metric(id),
  report_id      int references rpt_report(id),
  dimension_keys jsonb default '[]'::jsonb,
  series         jsonb default '[]'::jsonb, -- [{"fieldKey":"amount","agg":"sum","name":"合同金额"}]
  filters        jsonb default '[]'::jsonb,
  sort_strategy  varchar(16) default 'value_desc', -- value_desc/value_asc/axis
  limit_rows     int default 20,
  scope          varchar(16) default 'global',     -- global 全量 / dept 本部门 / self 仅本人（按角色数据范围动态收敛）
  sum_mode       varchar(16) default 'latest',     -- card 取值口径：latest/mtd/last7/last30
  compare        varchar(16),              -- card 环比：day/month/none
  style          jsonb default '{}'::jsonb,
  unit           varchar(16),
  prefix         varchar(16),
  icon           varchar(32),
  sort_no        int default 0,
  status         char(1) default '1',
  created_at     timestamp default now(),
  updated_at     timestamp default now()
);
comment on column bi_widget.series is '系列定义：[{fieldKey,agg,name}]，agg 即统计方式 计数/求和/平均/最大/最小';

create table bi_dashboard (
  id          serial primary key,
  code        varchar(48) not null unique,
  name        varchar(64) not null,
  description varchar(255),
  owner_id    int references sys_user(id),
  is_default  boolean default false,
  sort_no     int default 0,
  status      char(1) default '1',
  created_at  timestamp default now()
);

create table bi_dashboard_widget (
  id           serial primary key,
  dashboard_id int not null references bi_dashboard(id) on delete cascade,
  widget_id    int not null references bi_widget(id) on delete cascade,
  col_span     int default 4,   -- 24 栅格
  height       int default 120,
  sort_no      int default 0,
  unique (dashboard_id, widget_id)
);

-- ---------------------------------------------------------------- 5. 任务调度

create table bi_task (
  id           serial primary key,
  code         varchar(48) not null unique,
  name         varchar(64) not null,
  task_type    varchar(24) not null,   -- metric_calc 指标计算 / metric_backfill 指标补算 / data_archive 数据归档
  cron_expr    varchar(64) default '0 30 1 * * *',
  date_offset  int default 1,          -- T+N，1 即 T+1 取前一天
  target       jsonb default '{"all":true}'::jsonb,
  status       char(1) default '1',
  last_run_at  timestamp,
  last_status  varchar(16),
  next_run_at  timestamp,
  owner_id     int references sys_user(id),
  description  varchar(255),
  created_at   timestamp default now(),
  updated_at   timestamp default now()
);
comment on column bi_task.date_offset is '数据日期偏移：1 = T+1（计算前一天）';

create table bi_task_log (
  id            bigserial primary key,
  task_id       int,
  task_code     varchar(48),
  stat_date     date,
  start_time    timestamp default now(),
  end_time      timestamp,
  status        varchar(16),        -- running/success/failed
  rows_affected int default 0,
  message       text,
  trigger_by    varchar(64)         -- schedule / manual:用户名
);
create index idx_task_log_task on bi_task_log(task_id, start_time desc);
