package com.crazy4lamb.crmbi.controller;

import static com.crazy4lamb.crmbi.controller.AuthController.user;
import static com.crazy4lamb.crmbi.core.Api.ok;

import com.crazy4lamb.crmbi.core.ApiException;
import com.crazy4lamb.crmbi.core.Db;
import com.crazy4lamb.crmbi.core.UserPrincipal;
import com.crazy4lamb.crmbi.service.AclService;
import com.crazy4lamb.crmbi.service.TaskSchedulerService;
import jakarta.servlet.http.HttpServletRequest;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/task")
public class TaskController {

  /** 允许的任务类型白名单。 */
  private static final List<Map<String,Object>> TASK_TYPES = List.of(
      Map.of("value", "metric_calc", "label", "指标计算（T+N）"),
      Map.of("value", "metric_backfill", "label", "指标补算"),
      Map.of("value", "data_archive", "label", "数据归档校验"));

  /** 允许的统计范围白名单。 */
  private static final List<String> SCOPES = List.of("all", "dept", "self");

  private final Db db;
  private final AclService acl;
  private final TaskSchedulerService scheduler;

  public TaskController(Db db, AclService acl, TaskSchedulerService scheduler) {
    this.db = db;
    this.acl = acl;
    this.scheduler = scheduler;
  }

  // ------------------------------------------------------------------ 元数据

  @GetMapping("/meta")
  public Map<String,Object> meta(HttpServletRequest request) {
    return db.tx(user(request), ignored -> ok(Map.of(
        "taskTypes", TASK_TYPES,
        "metrics", db.many(
            "select id,code,name,metric_group,agg_fn,date_mode,unit"
                + " from bi_metric where status='1' order by metric_group,id"),
        "cronExamples", List.of(
            List.of("0 30 1 * * *", "每天 01:30"),
            List.of("0 0 2 * * *", "每天 02:00"),
            List.of("0 0 3 * * MON", "每周一 03:00")),
        "scopes", List.of(
            Map.of("value", "all", "label", "全部指标"),
            Map.of("value", "dept", "label", "本部门"),
            Map.of("value", "self", "label", "仅本人")),
        "schedulerOn", scheduler.status().get("enabled"))));
  }

  // ------------------------------------------------------------------ 列表与日志

  @GetMapping("/list")
  public Map<String,Object> list(HttpServletRequest request) {
    return db.tx(user(request), ignored -> {
      List<Map<String,Object>> rows = db.many(
          "select t.*, u.real_name owner_name,"
              + " (select status from bi_task_log l where l.task_id=t.id order by l.id desc limit 1) last_log_status,"
              + " (select count(*)::int from bi_task_log l where l.task_id=t.id) run_count,"
              + " (select count(*)::int from bi_task_log l where l.task_id=t.id and l.status='failed') fail_count"
              + " from bi_task t left join sys_user u on u.id=t.owner_id order by t.id");

      rows.forEach(row -> {
        row.put("cron_desc", scheduler.describe(text(row.get("cron_expr"))));
        Object next = row.get("next_run_at");
        row.put("next_run_at", next instanceof java.sql.Timestamp stamp
            ? stamp.toLocalDateTime() : next);
        row.put("offset_label", "T+" + text(row.get("date_offset"), "1"));
      });
      return ok(rows);
    });
  }

  @GetMapping("/logs")
  public Map<String,Object> logs(@RequestParam(defaultValue = "100") int limit,
                                 @RequestParam(required = false) Integer taskId,
                                 HttpServletRequest request) {
    return db.tx(user(request), ignored -> {
      int max = Math.max(1, Math.min(500, limit));
      Map<String,Object> params = new LinkedHashMap<>();
      params.put("limit", max);
      String sql = "select * from bi_task_log";
      if (taskId != null) {
        sql += " where task_id=:task";
        params.put("task", taskId);
      }
      return ok(db.many(sql + " order by id desc limit :limit", params));
    });
  }

  @GetMapping("/scheduler/status")
  public Map<String,Object> status(HttpServletRequest request) {
    return db.tx(user(request), ignored -> {
      Map<String,Object> out = new LinkedHashMap<>(scheduler.status());
      out.put("jobs", scheduler.registered());
      return ok(out);
    });
  }

  // ------------------------------------------------------------------ 执行

  @PostMapping("/{id}/run")
  public Map<String,Object> run(@PathVariable int id,
                                @RequestBody(required = false) Map<String,Object> body,
                                HttpServletRequest request) {
    UserPrincipal user = user(request);
    requireAction(user, "task:run", "无权限：需要「任务运行」权限");
    Map<String,Object> task = db.tx(user,
        ignored -> db.one("select * from bi_task where id=:id", Map.of("id", id)));
    if (task == null) throw ApiException.notFound("任务不存在");

    LocalDate statDate = body != null && body.get("statDate") != null
        ? LocalDate.parse(String.valueOf(body.get("statDate")))
        : LocalDate.now().minusDays(offset(task));

    // 调度服务会开启 system 数据范围事务，保证后台执行与手动执行口径一致。
    Map<String,Object> result = scheduler.execute(id, statDate, "manual:" + user.username());
    return ok(result, "执行成功，处理 " + result.get("rows") + " 条记录");
  }

  // ------------------------------------------------------------------ 设计

  @PostMapping
  public Map<String,Object> create(@RequestBody Map<String,Object> body, HttpServletRequest request) {
    UserPrincipal user = user(request);
    requireAction(user, "task:edit", "无权限：需要「任务编辑」权限");
    requireBody(body);
    return db.tx(user, ignored -> {
      String code = text(body.get("code"), "task_" + Long.toString(System.currentTimeMillis(), 36));
      Map<String,Object> params = taskParams(body, code);
      params.put("owner", user.id());
      Number id = db.insertId(
          "insert into bi_task(code,name,task_type,cron_expr,date_offset,target,status,owner_id,description)"
              + " values(:code,:name,:type,:cron,:offset,cast(:target as jsonb),:status,:owner,:description)",
          params);
      db.update("insert into sys_acl(role_code,res_type,res_key) values(:role,'action',:code)"
          + " on conflict do nothing", Map.of("role", user.role(), "code", code));
      scheduler.reload();
      return ok(Map.of("id", id, "code", code), "任务已创建");
    });
  }

  @PutMapping("/{id}")
  public Map<String,Object> update(@PathVariable int id, @RequestBody Map<String,Object> body,
                                   HttpServletRequest request) {
    UserPrincipal user = user(request);
    requireAction(user, "task:edit", "无权限：需要「任务编辑」权限");
    return db.tx(user, ignored -> {
      Map<String,Object> params = taskParams(body, null);
      params.put("id", id);
      int changed = db.update(
          "update bi_task set name=:name,task_type=:type,cron_expr=:cron,date_offset=:offset,"
              + "target=cast(:target as jsonb),status=:status,description=:description,updated_at=now()"
              + " where id=:id",
          params);
      if (changed == 0) throw ApiException.notFound("任务不存在");
      scheduler.reload();
      return ok(null, "已保存");
    });
  }

  @DeleteMapping("/{id}")
  public Map<String,Object> delete(@PathVariable int id, HttpServletRequest request) {
    UserPrincipal user = user(request);
    requireAction(user, "task:edit", "无权限：需要「任务编辑」权限");
    return db.tx(user, ignored -> {
      Map<String,Object> task = db.one("select code from bi_task where id=:id", Map.of("id", id));
      if (task == null) throw ApiException.notFound("任务不存在");
      db.update("delete from bi_task where id=:id", Map.of("id", id));
      db.update("delete from sys_acl where res_type='action' and res_key=:code",
          Map.of("code", task.get("code")));
      scheduler.reload();
      return ok(null, "已删除");
    });
  }

  // ------------------------------------------------------------------ 工具

  private void requireAction(UserPrincipal user, String action, String message) {
    acl.require(user, "action", action, message);
  }

  private void requireBody(Map<String,Object> body) {
    if (body.get("name") == null) throw ApiException.bad("任务名称必填");
    String cron = text(body.get("cronExpr"), "0 30 1 * * *");
    try {
      org.springframework.scheduling.support.CronExpression.parse(cron);
    } catch (IllegalArgumentException e) {
      throw ApiException.bad("Cron 表达式无效：" + cron);
    }
  }

  private Map<String,Object> taskParams(Map<String,Object> body, String code) {
    Map<String,Object> params = new LinkedHashMap<>();
    if (code != null) params.put("code", code);
    params.put("name", body.get("name"));
    params.put("type", taskType(body.get("taskType")));
    params.put("cron", text(body.get("cronExpr"), "0 30 1 * * *"));
    params.put("offset", offset(body));
    params.put("target", toJson(target(body.get("target"))));
    params.put("status", text(body.get("status"), "1"));
    params.put("description", body.get("description"));
    return params;
  }

  private String taskType(Object value) {
    String type = text(value, "metric_calc");
    return TASK_TYPES.stream().anyMatch(item -> type.equals(item.get("value")))
        ? type
        : "metric_calc";
  }

  private int offset(Map<String,Object> task) {
    Object value = task.get("date_offset");
    if (value instanceof Number n) return Math.max(0, Math.min(30, n.intValue()));
    try {
      return Math.max(0, Math.min(30, Integer.parseInt(text(value, "1"))));
    } catch (NumberFormatException e) {
      return 1;
    }
  }

  /** target 支持简写字符串或对象，统一归一为 {@code {"scope":"all"}}。 */
  private Map<String,Object> target(Object value) {
    Map<String,Object> out = new LinkedHashMap<>();
    if (value instanceof Map<?,?> map) {
      out.putAll((Map<String,Object>) map);
    } else if (value instanceof String text && !text.isBlank()) {
      out.put("scope", text);
    }
    String scope = text(out.get("scope"), "all");
    if (!SCOPES.contains(scope)) scope = "all";
    out.put("scope", scope);
    return out;
  }

  private String toJson(Object value) {
    try {
      return new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(value);
    } catch (Exception e) {
      throw ApiException.bad("任务配置格式无效");
    }
  }

  private static String text(Object value) {
    return value == null ? "" : String.valueOf(value);
  }

  private static String text(Object value, String fallback) {
    String text = text(value);
    return text.isEmpty() ? fallback : text;
  }
}
