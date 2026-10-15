package com.crazy4lamb.crmbi.controller;

import static com.crazy4lamb.crmbi.controller.AuthController.user;
import static com.crazy4lamb.crmbi.core.Api.ok;

import com.crazy4lamb.crmbi.core.ApiException;
import com.crazy4lamb.crmbi.core.Db;
import com.crazy4lamb.crmbi.core.UserPrincipal;
import com.zaxxer.hikari.HikariDataSource;
import jakarta.servlet.http.HttpServletRequest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** 系统管理：角色、用户、ACL 权限矩阵、运维统计、PostgreSQL 运行态。 */
@RestController
@RequestMapping("/api/sys")
public class SystemController {
  /** ACL 支持的资源类型，顺序即前端矩阵的列顺序。 */
  private static final List<String> ACL_TYPES = List.of("menu", "action", "card", "chart", "report", "dashboard");

  /** 全部可授权的 action 码，ACL 页据此渲染动作清单。 */
  private static final List<String> ACTIONS = List.of(
      "customer:add", "customer:edit", "customer:delete",
      "customer-pool:claim", "customer-pool:release",
      "lead:add", "lead:claim", "lead:assign", "lead:edit",
      "opp:add", "opp:edit",
      "payment:add",
      "contract:add", "contract:edit",
      "order:add", "order:edit",
      "follow:add",
      "report:design", "widget:design", "metric:design",
      "task:run", "task:edit",
      "user:edit");

  /** 首页"系统概览"要统计行数的表。 */
  private static final List<String> COUNTED_TABLES = List.of(
      "sys_user", "crm_customer", "crm_lead", "crm_lead_pool",
      "crm_opportunity", "crm_contract", "crm_order", "crm_follow_up",
      "rpt_dataset", "rpt_report", "bi_metric", "bi_metric_value",
      "bi_widget", "bi_dashboard", "bi_task", "bi_task_log");

  private final Db db;
  private final PasswordEncoder passwords;
  private final HikariDataSource pool;

  public SystemController(Db db, PasswordEncoder passwords, javax.sql.DataSource source) {
    this.db = db;
    this.passwords = passwords;
    this.pool = (HikariDataSource) source;
  }

  // ------------------------------------------------------------------ 角色与用户

  @GetMapping("/roles")
  public Map<String,Object> roles(HttpServletRequest request) {
    UserPrincipal user = user(request);
    admin(user);
    return db.tx(user, tx -> {
      List<Map<String,Object>> rows = db.many("""
          select r.*, (select count(*)::int from sys_user u where u.role_code = r.code) user_count
          from sys_role r
          order by sort_no""");
      rows.forEach(row -> row.put("userCount", row.remove("user_count")));
      return ok(rows);
    });
  }

  @GetMapping("/users")
  public Map<String,Object> users(HttpServletRequest request) {
    UserPrincipal user = user(request);
    admin(user);
    return db.tx(user, tx -> ok(db.many("""
        select u.id, u.username, u.real_name, u.role_code, r.name role_name,
               u.dept, u.phone, u.email, u.data_scope, u.status,
               u.last_login_at, u.created_at
        from sys_user u
        left join sys_role r on r.code = u.role_code
        order by u.id""")));
  }

  @PostMapping("/users")
  public Map<String,Object> createUser(@RequestBody Map<String,Object> body, HttpServletRequest request) {
    UserPrincipal user = user(request);
    admin(user);
    if (body.get("username") == null || body.get("real_name") == null || body.get("role_code") == null) {
      throw ApiException.bad("用户名/姓名/角色必填");
    }
    return db.tx(user, tx -> {
      Number id = db.insertId("""
          insert into sys_user(username, password, real_name, role_code, dept, phone, email, data_scope, status)
          values(:username, :password, :name, :role, :dept, :phone, :email, :scope, :status)""",
          params(
              "username", body.get("username"),
              "password", passwords.encode(String.valueOf(body.getOrDefault("password", "123456"))),
              "name", body.get("real_name"),
              "role", body.get("role_code"),
              "dept", body.get("dept"),
              "phone", body.get("phone"),
              "email", body.get("email"),
              "scope", body.getOrDefault("data_scope", "self"),
              "status", body.getOrDefault("status", "1")));
      return ok(Map.of("id", id), "用户已创建");
    });
  }

  @PutMapping("/users/{id}")
  public Map<String,Object> updateUser(
      @PathVariable int id, @RequestBody Map<String,Object> body, HttpServletRequest request) {
    UserPrincipal user = user(request);
    admin(user);
    return db.tx(user, tx -> {
      // 全部用 coalesce，只更新请求体里真正带了的字段
      db.update("""
          update sys_user
          set real_name  = coalesce(:name, real_name),
              role_code  = coalesce(:role, role_code),
              dept       = coalesce(:dept, dept),
              phone      = coalesce(:phone, phone),
              email      = coalesce(:email, email),
              data_scope = coalesce(:scope, data_scope),
              status     = coalesce(:status, status)
          where id = :id""",
          params(
              "name", body.get("real_name"),
              "role", body.get("role_code"),
              "dept", body.get("dept"),
              "phone", body.get("phone"),
              "email", body.get("email"),
              "scope", body.get("data_scope"),
              "status", body.get("status"),
              "id", id));

      if (body.get("password") != null) {
        db.update("update sys_user set password = :password where id = :id",
            Map.of("password", passwords.encode(String.valueOf(body.get("password"))), "id", id));
      }
      return ok(null, "已保存");
    });
  }

  @DeleteMapping("/users/{id}")
  public Map<String,Object> deleteUser(@PathVariable int id, HttpServletRequest request) {
    UserPrincipal user = user(request);
    admin(user);
    if (id == user.id()) throw ApiException.bad("不能删除当前登录账号");
    return db.tx(user, tx -> {
      db.update("delete from sys_user where id = :id", Map.of("id", id));
      return ok(null, "已删除");
    });
  }

  // ------------------------------------------------------------------ ACL 权限矩阵

  @GetMapping("/acl")
  @SuppressWarnings("unchecked")
  public Map<String,Object> acl(HttpServletRequest request) {
    UserPrincipal user = user(request);
    admin(user);
    return db.tx(user, tx -> {
      List<Map<String,Object>> roles = db.many("select code, name from sys_role order by sort_no");
      List<Map<String,Object>> menus = db.many("select code, name, parent_code from sys_menu order by sort_no");
      List<Map<String,Object>> cards = db.many("select code, name from bi_widget where widget_type = 'card'");
      List<Map<String,Object>> charts = db.many("select code, name from bi_widget where widget_type = 'chart'");
      List<Map<String,Object>> reports = db.many("select id::text code, name from rpt_report");
      List<Map<String,Object>> dashboards = db.many("select code, name from bi_dashboard");

      // 每个角色先给六种类型各建一个空数组，保证前端拿到的是完整矩阵
      Map<String,Object> matrix = new LinkedHashMap<>();
      for (Map<String,Object> role : roles) {
        Map<String,List<String>> perms = new LinkedHashMap<>();
        for (String type : ACL_TYPES) perms.put(type, new ArrayList<>());
        matrix.put(String.valueOf(role.get("code")), perms);
      }
      for (Map<String,Object> row : db.many("select role_code, res_type, res_key from sys_acl")) {
        Map<String,List<String>> perms =
            (Map<String,List<String>>) matrix.get(String.valueOf(row.get("role_code")));
        if (perms != null) {
          perms.computeIfAbsent(String.valueOf(row.get("res_type")), key -> new ArrayList<>())
              .add(String.valueOf(row.get("res_key")));
        }
      }

      List<Map<String,Object>> actions = ACTIONS.stream()
          .map(code -> Map.<String,Object>of("code", code, "name", code))
          .toList();

      Map<String,Object> resources = new LinkedHashMap<>();
      resources.put("menu", menus);
      resources.put("action", actions);
      resources.put("card", cards);
      resources.put("chart", charts);
      resources.put("report", reports);
      resources.put("dashboard", dashboards);

      return ok(Map.of("roles", roles, "resources", resources, "matrix", matrix));
    });
  }

  @PostMapping("/acl")
  public Map<String,Object> saveAcl(@RequestBody Map<String,Object> body, HttpServletRequest request) {
    UserPrincipal user = user(request);
    admin(user);
    return db.tx(user, tx -> {
      Map<String,Object> params = Map.of(
          "role", body.get("roleCode"),
          "type", body.get("resType"),
          "key", body.get("resKey"));
      if (Boolean.TRUE.equals(body.get("enabled"))) {
        db.update("""
            insert into sys_acl(role_code, res_type, res_key)
            values(:role, :type, :key)
            on conflict do nothing""", params);
      } else {
        db.update("""
            delete from sys_acl
            where role_code = :role and res_type = :type and res_key = :key""", params);
      }
      return ok(null, "权限已更新");
    });
  }

  // ------------------------------------------------------------------ 运维视图

  @GetMapping("/stats")
  public Map<String,Object> stats(HttpServletRequest request) {
    UserPrincipal user = user(request);
    return db.tx(user, tx -> {
      Map<String,Object> counts = new LinkedHashMap<>();
      for (String table : COUNTED_TABLES) {
        counts.put(table, db.one("select count(*) c from " + table).get("c"));
      }
      Map<String,Object> info = db.one("select version() v, current_database() d, current_date today");

      return ok(Map.of(
          "db", Map.of(
              "mode", "pg",
              "label", "PostgreSQL @ " + info.get("d"),
              "version", info.get("v")),
          "today", info.get("today"),
          "counts", counts,
          "backend", "Spring Boot 3.5.8 / Java 21"));
    });
  }

  /** PostgreSQL 运行态诊断：版本、连接池、索引、RLS 策略、迁移、表统计、慢查询计划。 */
  @GetMapping("/postgres")
  public Map<String,Object> postgres(HttpServletRequest request) {
    UserPrincipal user = user(request);
    admin(user);
    return db.tx(user, tx -> {
      Map<String,Object> database = db.one("""
          select version() version,
                 current_database() name,
                 current_user "user",
                 pg_database_size(current_database()) bytes,
                 (select rolsuper from pg_roles where rolname = current_user) superuser,
                 (select rolbypassrls from pg_roles where rolname = current_user) bypass_rls""");
      Map<String,Object> snapshot = db.one(
          "select *, source_version > refreshed_version stale from bi_refresh_state where id = 1");
      Map<String,Object> audit = db.one(
          "select count(*)::int records, max(occurred_at) latest from crm_audit");

      List<Map<String,Object>> indexes = db.many("""
          select indexname, tablename, indexdef from pg_indexes
          where schemaname = 'public' order by tablename, indexname""");
      List<Map<String,Object>> policies = db.many("""
          select tablename, policyname, cmd from pg_policies
          where schemaname = 'public'""");
      List<Map<String,Object>> migrations = db.many(
          "select version, applied_at from app_migration order by version");
      List<Map<String,Object>> tables = db.many("""
          select relname, n_live_tup, seq_scan, idx_scan from pg_stat_user_tables
          where schemaname = 'public' and relname like 'crm_%'""");

      var mx = pool.getHikariPoolMXBean();
      Map<String,Object> poolStats = Map.of(
          "total", mx.getTotalConnections(),
          "active", mx.getActiveConnections(),
          "idle", mx.getIdleConnections(),
          "waiting", mx.getThreadsAwaitingConnection(),
          "max", pool.getMaximumPoolSize());

      // 用真实的 EXPLAIN 计划验证客户名模糊搜索走得上索引
      Object searchPlan = db.many(
              "explain(analyze, buffers, format json) select id from crm_customer where name ilike '%科技%' limit 20")
          .getFirst().values().iterator().next();

      Map<String,Object> result = new LinkedHashMap<>();
      result.put("enabled", true);
      result.put("database", database);
      result.put("pool", poolStats);
      result.put("indexes", indexes);
      result.put("policies", policies);
      result.put("snapshot", snapshot);
      result.put("audit", audit);
      result.put("migrations", migrations);
      result.put("tables", tables);
      result.put("searchPlan", searchPlan);
      result.put("backend", Map.of(
          "framework", "Spring Boot 3.5.8",
          "java", "21",
          "dataAccess", "Spring JDBC + HikariCP"));
      return ok(result);
    });
  }

  /** 手动触发经营快照物化（函数 bi_refresh_sales 会做幂等刷新）。 */
  @PostMapping("/postgres/refresh")
  public Map<String,Object> refresh(HttpServletRequest request) {
    UserPrincipal user = user(request);
    admin(user);
    return db.tx(user, tx -> {
      Object refreshed = db.one("select bi_refresh_sales() refreshed").get("refreshed");
      return ok(Map.of("refreshed", refreshed),
          Boolean.TRUE.equals(refreshed) ? "经营快照已刷新" : "当前正在刷新，请稍后查看");
    });
  }

  @GetMapping("/oper-logs")
  public Map<String,Object> logs(HttpServletRequest request) {
    UserPrincipal user = user(request);
    admin(user);
    return db.tx(user, tx -> ok(db.many("select * from sys_oper_log order by id desc limit 100")));
  }

  // ------------------------------------------------------------------ 内部工具

  private static void admin(UserPrincipal user) {
    if (!user.admin()) throw ApiException.forbidden("无权限：仅系统管理员可访问");
  }

  /** 把 `k,v,k,v...` 的变长参数转成具名参数 Map。 */
  private static Map<String,Object> params(Object... values) {
    Map<String,Object> out = new LinkedHashMap<>();
    for (int i = 0; i < values.length; i += 2) {
      out.put(String.valueOf(values[i]), values[i + 1]);
    }
    return out;
  }
}
