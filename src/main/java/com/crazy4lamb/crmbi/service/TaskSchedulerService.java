package com.crazy4lamb.crmbi.service;

import com.crazy4lamb.crmbi.core.Db;
import java.time.Duration;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.scheduling.support.CronExpression;
import org.springframework.stereotype.Service;

/**
 * 任务调度器：按 {@code bi_task.cron_expr} 动态注册定时作业，让 T+1 指标自动计算。
 *
 * <p>启动时读取全部启用任务注册作业；新增、修改、删除任务后调用 {@link #reload()} 重建调度表。
 * {@code next_run_at} 由 {@link CronExpression} 真实推算，不再是写死的「明天」。
 */
@Service
public class TaskSchedulerService {

  private static final Logger log = LoggerFactory.getLogger(TaskSchedulerService.class);

  private final Db db;
  private final MetricService metrics;
  private final TaskScheduler scheduler;
  private final ZoneId zone;
  private final boolean enabled;

  /** taskId → 已注册的作业句柄。 */
  private final Map<Integer, ScheduledFuture<?>> jobs = new ConcurrentHashMap<>();
  private final AtomicBoolean ready = new AtomicBoolean(false);

  public TaskSchedulerService(Db db, MetricService metrics, TaskScheduler scheduler,
                              @Value("${app.timezone:Asia/Shanghai}") String timezone,
                              @Value("${app.scheduler.enabled:true}") boolean enabled) {
    this.db = db;
    this.metrics = metrics;
    this.scheduler = scheduler;
    this.zone = ZoneId.of(timezone);
    this.enabled = enabled;
  }

  /** 应用就绪后加载任务表。 */
  @EventListener(ApplicationReadyEvent.class)
  public void onReady() {
    if (!enabled) {
      log.info("任务调度器未启用（app.scheduler.enabled=false）");
      return;
    }
    reload();
    ready.set(true);
  }

  /** 重新加载全部启用任务，替换现有调度。 */
  public synchronized void reload() {
    cancelAll();
    List<Map<String,Object>> tasks;
    try {
      tasks = db.many("select id,code,name,cron_expr,date_offset from bi_task where status='1' order by id");
    } catch (RuntimeException e) {
      log.warn("读取任务表失败，本次不注册任何调度：{}", e.getMessage());
      return;
    }
    for (Map<String,Object> task : tasks) {
      try {
        schedule(task);
      } catch (RuntimeException e) {
        log.warn("任务 {} 的 cron 表达式无效，已跳过：{}", task.get("code"), e.getMessage());
      }
    }
    log.info("已注册 {} 个定时任务", jobs.size());
  }

  private void schedule(Map<String,Object> task) {
    int id = ((Number) task.get("id")).intValue();
    String code = String.valueOf(task.get("code"));
    String cron = String.valueOf(task.get("cron_expr"));
    CronExpression expression = CronExpression.parse(cron);
    int offset = task.get("date_offset") instanceof Number n ? n.intValue() : 1;

    LocalDateTime next = nextRun(expression, LocalDateTime.now(zone));
    db.update("update bi_task set next_run_at=:next where id=:id",
        Map.of("next", java.sql.Timestamp.valueOf(next), "id", id));

    // 每分钟轮询一次，推断是否到达触发点：避免直接依赖 cron 表达式的秒字段解析差异
    ScheduledFuture<?> future = scheduler.scheduleAtFixedRate(
        () -> tick(id, code, offset, expression),
        Duration.ofMinutes(1));

    jobs.put(id, future);
  }

  /** 每分钟检查一次：到点则执行，并把下次执行时间推进一步。 */
  private void tick(int taskId, String code, int dateOffset, CronExpression expression) {
    try {
      LocalDateTime now = LocalDateTime.now(zone).withSecond(0).withNano(0);
      LocalDateTime due = nextRun(expression, now.minusMinutes(1));
      if (due.isAfter(now)) return;

      LocalDate statDate = now.toLocalDate().minusDays(dateOffset);
      execute(taskId, statDate, "schedule");
      LocalDateTime next = nextRun(expression, now);
      db.update("update bi_task set next_run_at=:next where id=:id",
          Map.of("next", java.sql.Timestamp.valueOf(next), "id", taskId));
    } catch (RuntimeException e) {
      log.warn("任务 {} 定时执行失败：{}", code, e.getMessage());
    }
  }

  /**
   * 执行一次任务：落 {@code bi_task_log} 并把全部启用指标的该日期值算出来。
   *
   * @return 写入的指标条数
   */
  public Map<String,Object> execute(int taskId, LocalDate statDate, String triggerBy) {
    Map<String,Object> task = db.one("select * from bi_task where id=:id", Map.of("id", taskId));
    if (task == null) throw new IllegalArgumentException("任务不存在");

    String code = String.valueOf(task.get("code"));
    Number logId = db.insertId(
        "insert into bi_task_log(task_id,task_code,stat_date,status,trigger_by)"
            + " values(:id,:code,:date,'running',:by)",
        Map.of("id", taskId, "code", code,
            "date", java.sql.Date.valueOf(statDate), "by", triggerBy));

    long start = System.nanoTime();
    try {
      return db.tx(null, ignored -> {
        Map<String,Object> lock = db.one(
            "select pg_try_advisory_xact_lock(hashtext(:key)) locked",
            Map.of("key", "crm-bi:task:" + taskId));
        if (lock == null || !Boolean.TRUE.equals(lock.get("locked"))) {
          db.update(
              "update bi_task_log set end_time=now(),status='skipped',rows_affected=0,"
                  + "message='同一任务正在其他实例执行' where id=:id",
              Map.of("id", logId));
          return result(false, 0, 0, "skipped");
        }

        String type = String.valueOf(task.get("task_type"));
        int rows = switch (type) {
          case "metric_calc" -> calculate(task, List.of(statDate), logId);
          case "metric_backfill" -> calculate(task, backfillDates(statDate), logId);
          case "data_archive" -> archiveCheck(task);
          default -> throw new IllegalArgumentException("不支持的任务类型：" + type);
        };

        int duration = (int) ((System.nanoTime() - start) / 1_000_000);
        String message = switch (type) {
          case "metric_calc" -> "已计算 " + rows + " 个指标";
          case "metric_backfill" -> "已补算 " + rows + " 条指标值";
          case "data_archive" -> "归档前完整性检查完成，候选记录 " + rows + " 条";
          default -> "任务完成";
        } + "，耗时 " + duration + "ms";

        db.update(
            "update bi_task_log set end_time=now(),status='success',rows_affected=:rows,message=:msg"
                + " where id=:id",
            Map.of("rows", rows, "msg", message, "id", logId));
        db.update("update bi_task set last_run_at=now(),last_status='success' where id=:id",
            Map.of("id", taskId));

        return result(true, rows, duration, type);
      });
    } catch (RuntimeException e) {
      db.update(
          "update bi_task_log set end_time=now(),status='failed',message=:msg where id=:id",
          Map.of("msg", String.valueOf(e.getMessage()), "id", logId));
      db.update("update bi_task set last_run_at=now(),last_status='failed' where id=:id",
          Map.of("id", taskId));
      throw e;
    }
  }

  /** 按任务 target 选取指标，并对给定日期逐日计算。 */
  private int calculate(Map<String,Object> task, List<LocalDate> dates, Number logId) {
    Map<String,Object> target = map(task.get("target"));
    List<Integer> metricIds = intList(target.get("metricIds"));
    String sql = "select * from bi_metric where status='1'";
    Map<String,Object> params = new LinkedHashMap<>();
    if (!metricIds.isEmpty()) {
      sql += " and id in (:ids)";
      params.put("ids", metricIds);
    }
    List<Map<String,Object>> selected = db.many(sql + " order by id", params);
    int rows = 0;
    for (LocalDate date : dates) {
      for (Map<String,Object> metric : selected) {
        metrics.persist(metric, date, logId);
        rows++;
      }
    }
    return rows;
  }

  /** 补算从指定起始日到昨天，最多 31 天，防止配置错误拖垮数据库。 */
  private List<LocalDate> backfillDates(LocalDate from) {
    LocalDate to = LocalDate.now(zone).minusDays(1);
    LocalDate start = from.isAfter(to) ? to : from;
    if (start.isBefore(to.minusDays(30))) start = to.minusDays(30);
    List<LocalDate> dates = new ArrayList<>();
    for (LocalDate date = start; !date.isAfter(to); date = date.plusDays(1)) dates.add(date);
    return dates;
  }

  /**
   * 归档任务只做安全检查和统计，不自动删除业务数据。VACUUM/ANALYZE 由 PostgreSQL 自主管理，
   * 这里刷新统计信息并返回超过保留期的候选记录数。
   */
  private int archiveCheck(Map<String,Object> task) {
    int months = integer(map(task.get("target")).get("keepMonths"), 24, 1, 120);
    db.one("select crm_analyze_business() analyzed");
    Map<String,Object> row = db.one("""
        select
          (select count(*) from crm_customer
            where created_at < current_date - make_interval(months => :months))
          + (select count(*) from crm_lead
            where created_at < current_date - make_interval(months => :months))
          + (select count(*) from crm_contract
            where sign_date < current_date - make_interval(months => :months))
          + (select count(*) from crm_order
            where order_date < current_date - make_interval(months => :months)) as candidates""",
        Map.of("months", months));
    return row == null ? 0 : ((Number) row.get("candidates")).intValue();
  }

  private static Map<String,Object> result(boolean ok, int rows, int duration, String type) {
    Map<String,Object> out = new LinkedHashMap<>();
    out.put("ok", ok);
    out.put("rows", rows);
    out.put("durationMs", duration);
    out.put("type", type);
    return out;
  }

  @SuppressWarnings("unchecked")
  private static Map<String,Object> map(Object value) {
    return value instanceof Map<?,?> item ? (Map<String,Object>) item : Map.of();
  }

  private static List<Integer> intList(Object value) {
    if (!(value instanceof List<?> list)) return List.of();
    List<Integer> out = new ArrayList<>();
    for (Object item : list) {
      if (item instanceof Number number) out.add(number.intValue());
      else {
        try {
          out.add(Integer.parseInt(String.valueOf(item)));
        } catch (NumberFormatException ignored) {
          // 忽略非法指标 ID
        }
      }
    }
    return out;
  }

  private static int integer(Object value, int fallback, int min, int max) {
    int parsed = fallback;
    if (value instanceof Number number) parsed = number.intValue();
    else if (value != null) {
      try {
        parsed = Integer.parseInt(String.valueOf(value));
      } catch (NumberFormatException ignored) {
        parsed = fallback;
      }
    }
    return Math.max(min, Math.min(max, parsed));
  }

  /** 推算下一次执行时间。 */
  public LocalDateTime nextRun(CronExpression expression, LocalDateTime from) {
    return expression.next(from);
  }

  /** 按 cron 表达式推算下一次执行时间；表达式非法时返回 null。 */
  public LocalDateTime nextRunAt(Object cron) {
    if (cron == null) return null;
    try {
      return CronExpression.parse(String.valueOf(cron).trim()).next(LocalDateTime.now(zone));
    } catch (IllegalArgumentException invalid) {
      return null;
    }
  }

  /**
   * 把 Spring 的 6 段 cron（秒 分 时 日 月 周）翻成中文可读描述。
   *
   * <p>只处理最常用的几种形态，其余原样返回，避免给出错误描述误导用户。
   */
  public String describe(String cron) {
    if (cron == null || cron.isBlank()) return "未设置";
    String[] parts = cron.trim().split("\\s+");
    if (parts.length != 6) return cron.trim();

    String second = parts[0];
    String minute = parts[1];
    String hour = parts[2];
    String day = parts[3];
    String month = parts[4];
    String week = parts[5];
    boolean daily = "*".equals(second) || "0".equals(second);
    boolean everyDay = "*".equals(day) && "*".equals(month) && "*".equals(week);

    // 每天固定时刻，例如 0 30 1 * * * → 每天 01:30
    if (daily && everyDay && isNumber(hour) && isNumber(minute)) {
      return "每天 " + pad(hour) + ":" + pad(minute);
    }
    // 每周指定星期，例如 0 0 3 * * 0 → 每周日 03:00
    if (daily && "*".equals(day) && "*".equals(month) && isDigit(week) && isNumber(hour)) {
      String[] names = {"周日", "周一", "周二", "周三", "周四", "周五", "周六"};
      return "每" + names[Integer.parseInt(week)] + " " + pad(hour) + ":" + pad(minute);
    }
    // 每小时：分钟位为*
    if (daily && everyDay && "*".equals(minute) && !"*".equals(hour)) {
      return "每小时";
    }
    return cron.trim();
  }

  /** 是否为纯数字（cron 里表示具体数值而非通配）。 */
  private static boolean isNumber(String value) {
    return !value.isEmpty() && isAllDigits(value);
  }

  /** 是否为 0-6 的单个数字（星期）。 */
  private static boolean isDigit(String value) {
    return value.length() == 1 && isAllDigits(value);
  }

  private static boolean isAllDigits(String value) {
    for (int i = 0; i < value.length(); i++) {
      if (value.charAt(i) < '0' || value.charAt(i) > '9') return false;
    }
    return true;
  }

  private static String pad(String value) {
    return value.length() == 1 ? "0" + value : value;
  }

  /** 调度器状态：真实反映是否启用与已注册作业数。 */
  public Map<String,Object> status() {
    Map<String,Object> out = new LinkedHashMap<>();
    out.put("enabled", enabled && ready.get());
    out.put("configured", enabled);
    out.put("jobs", jobs.size());
    out.put("timezone", zone.getId());
    return out;
  }

  /** 已注册的作业快照，供状态接口展示。 */
  public List<Map<String,Object>> registered() {
    List<Map<String,Object>> out = new ArrayList<>();
    try {
      for (Map<String,Object> task : db.many(
          "select id,code,name,cron_expr,next_run_at from bi_task where status='1' order by id")) {
        Map<String,Object> item = new LinkedHashMap<>();
        item.put("id", task.get("id"));
        item.put("code", task.get("code"));
        item.put("name", task.get("name"));
        item.put("cron_expr", task.get("cron_expr"));
        item.put("cron_desc", describe(String.valueOf(task.get("cron_expr"))));
        // 用 cron 实时推算，而不是读可能过期的 next_run_at 列
        item.put("next_run_at", String.valueOf(nextRunAt(task.get("cron_expr"))));
        item.put("scheduled", jobs.containsKey(((Number) task.get("id")).intValue()));
        out.add(item);
      }
    } catch (RuntimeException e) {
      log.warn("读取调度状态失败：{}", e.getMessage());
    }
    return out;
  }

  private void cancelAll() {
    jobs.values().forEach(future -> {
      try {
        future.cancel(false);
      } catch (RuntimeException ignored) {
        // 已完成的任务取消失败不影响重建
      }
    });
    jobs.clear();
  }
}
