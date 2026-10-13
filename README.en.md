# Yueke CRM · Customer Operations and Business Intelligence

[Bilingual home](README.md) · [中文说明](README.zh-CN.md)

Yueke CRM is a customer operations and business intelligence project built with **Java 21, Spring Boot 3.5, Spring Security, Spring JDBC, HikariCP, and PostgreSQL 18**. It connects acquisition, sales progression, contracting, orders, payments, customer service, and analytics through one business model.

## Implemented features

| Module | Behavior |
| --- | --- |
| Role dashboards | Menus, KPIs, charts, and reports assembled per role, with all, department, and personal scopes |
| Customer 360 | Profile, contacts, follow-ups, and a unified lead → opportunity → contract → order → payment journey |
| Shared pools | Claim and release prospects, claim and assign leads, and atomically convert a lead into a customer and contact |
| Opportunities | List and full stage board, stage amounts, expected dates, overdue counts, and stage advancement |
| Contracts, orders, payments | Contract value and cost, orders, partial payments, paid/receivable totals, and overpayment protection |
| Self-service BI | Grouping, aggregation, formula fields, filters, pagination, export, and 11 ECharts chart types |
| Metrics and jobs | 12 T+1 metrics with separate business formulas, 120-day backfill, manual recalculation, and logs |
| Administration | Users, roles, ACL matrix, database version, pool, indexes, RLS, migrations, and query plans |

The UI uses a dopamine-inspired orange, berry pink, mint, purple, blue, and yellow palette with narrow-screen navigation.

## Linked business data

The Customer 360 `journey` endpoint unifies lead, opportunity, contract, order, payment, and follow-up events with PostgreSQL `UNION ALL`, ordered by occurrence time. Contract value, order value, collected cash, and receivables are aggregated from linked tables in real time.

Metric jobs calculate each definition independently. Daily sales, month-to-date sales, contract count, order amount, order count, average order value, active customers, new customers, new leads, converted leads, conversion rate, and gross margin are persisted to `bi_metric_value` using their own SQL formulas.

## PostgreSQL capabilities

- The `crm_app` runtime role is neither a superuser nor a `BYPASSRLS` role.
- Each Spring JDBC transaction sets verified user, role, department, and scope through transaction-local `set_config` values.
- RLS covers customers, contacts, leads, opportunities, contracts, orders, payments, and follow-ups.
- Sequences generate business identifiers safely under concurrent inserts.
- `crm_convert_lead()` and row locking provide atomic lead conversion.
- Constraints and triggers reject overpayments and invalid amounts even through direct SQL.
- `pg_trgm` with GIN supports substring search; JSONB stores BI configuration and immutable audit details.
- Materialized views, window functions, and advisory locks support sales trends, running totals, and concurrent refresh.

## Run locally

Install Node.js 22+, npm, and Docker. Java 21 and Maven are supplied by the Docker build.

```sh
git clone https://github.com/Crazy4Lamb/crm-bi.git
cd crm-bi
npm ci
npm run setup
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787). The first setup creates an untracked `.env`, starts a dedicated PostgreSQL 18 instance, applies migrations, seeds demo records, and builds the Spring Boot app. Re-running setup applies new migrations while preserving existing business data.

Common demo accounts: administrator `admin / admin123`, general manager `gm01 / 123456`, sales representative `rep01 / 123456`, and analyst `ana01 / 123456`.

```sh
npm start          # build and start the Java application
npm stop           # stop Compose services
npm run db:up      # start PostgreSQL only
npm run db:migrate # apply incremental migrations
npm run db:backup  # create a pg_dump custom-format backup
```

## Validation

```sh
npm test          # 62 smoke + 37 CRM workflow and permission checks
npm run test:pg   # 31 PostgreSQL-specific checks
```

The 130 checks cover Spring Boot HTTP APIs, ACLs, RLS, pool reuse, rollback, concurrent identifiers, atomic conversion, Customer 360 linkage, concurrent payments, independent metric formulas, materialized views, window functions, audit data, and real query plans. GitHub Actions repeats them with Java 21 and an isolated PostgreSQL 18 service.

## Project layout

```text
src/main/java/        Spring Boot controllers, security, data access, and services
web/                  Vanilla JavaScript and bundled ECharts
server/db/            Database baseline, migrations, and seed tooling
server/services/      Node helpers used only for initialization and historical backfill
scripts/              Setup, backup, and end-to-end checks
Dockerfile            Java 21 multi-stage image
compose.yaml          Spring Boot and PostgreSQL 18
```

Node.js is limited to database setup, seed generation, and black-box regression tests. Spring Boot serves every runtime HTTP API.

![Role dashboard](docs/screenshots/dashboard.jpg)

![PostgreSQL diagnostics](docs/screenshots/postgresql.jpg)
