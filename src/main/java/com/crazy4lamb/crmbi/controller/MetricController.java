package com.crazy4lamb.crmbi.controller;

import static com.crazy4lamb.crmbi.controller.AuthController.user;
import static com.crazy4lamb.crmbi.core.Api.ok;

import com.crazy4lamb.crmbi.core.ApiException;
import com.crazy4lamb.crmbi.core.Db;
import com.crazy4lamb.crmbi.core.UserPrincipal;
import com.crazy4lamb.crmbi.service.AclService;
import com.crazy4lamb.crmbi.service.MetricService;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.DoubleSummaryStatistics;
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
@RequestMapping("/api/metric")
public class MetricController {
  private final Db db;
  private final AclService acl;
  private final MetricService metrics;
  private final ObjectMapper json;

  public MetricController(Db db, AclService acl, MetricService metrics, ObjectMapper json) {
    this.db = db;
    this.acl = acl;
    this.metrics = metrics;
    this.json = json;
  }

  // ------------------------------------------------------------------ 元数据

  /** 指标设计页的下拉选项：统计方式、日期口径、单位、方向、过滤操作符。 */
  @GetMapping("/meta")
  public Map<String,Object> meta(HttpServletRequest request) {
    UserPrincipal user = user(request);
    return db.tx(user, tx -> ok(Map.of(
        "reports", reports(),
        "aggs", pairs(
            "sum", "求和",
            "count", "计数",
            "count_distinct", "去重计数",
            "avg", "平均",
            "max", "最大",
            "min", "最小"),
        "dateModes", List.of(
            List.of("day", "当日"),
            List.of("mtd", "本月累计"),
            List.of("month", "整月"),
            List.of("last7", "近 7 天"),
            List.of("last30", "近 30 天"),
            List.of("all", "全部")),
        "units", List.of("元", "份", "笔", "家", "条", "个", "台", "%", "天"),
        "directions", List.of(
            List.of("up", "越大越好"),
            List.of("down", "越小越好")),
        "ops", pairs(
            "eq", "等于",
            "ne", "不等于",
            "gt", "大于",
            "ge", "大于等于",
            "lt", "小于",
            "le", "小于等于",
            "like", "包含",
            "isnull", "为空",
            "notnull", "不为空"))));
  }

  // ------------------------------------------------------------------ 查询

  /** 指标列表，附带每个指标最近一次的实际值与统计日期。 */
  @GetMapping("/list")
  public Map<String,Object> list(HttpServletRequest request) {
    return db.tx(user(request), tx -> ok(db.many("""
        select m.*, r.name report_name, r.code report_code,
               v.stat_date last_date, v.value last_value
        from bi_metric m
        left join rpt_report r on r.id = m.report_id
        left join lateral (
          select stat_date, value from bi_metric_value
          where metric_id = m.id order by stat_date desc limit 1
        ) v on true
        order by m.metric_group, m.id""")));
  }

  @GetMapping("/{id}")
  public Map<String,Object> one(@PathVariable int id, HttpServletRequest request) {
    return db.tx(user(request), tx -> {
      Map<String,Object> metric = db.one("select * from bi_metric where id = :id", Map.of("id", id));
      if (metric == null) throw ApiException.notFound("指标不存在");
      return ok(metric);
    });
  }

  /** 指标历史值 + 区间汇总（默认近 90 天）。 */
  @GetMapping("/{id}/values")
  public Map<String,Object> values(
      @PathVariable int id,
      @RequestParam(required = false) String from,
      @RequestParam(required = false) String to,
      HttpServletRequest request) {
    return db.tx(user(request), tx -> {
      String start = from == null ? LocalDate.now().minusDays(90).toString() : from;
      String end = to == null ? LocalDate.now().toString() : to;

      List<Map<String,Object>> values = db.many("""
          select stat_date, value, prev_value, calc_time
          from bi_metric_value
          where metric_id = :id
            and stat_date between cast(:from as date) and cast(:to as date)
          order by stat_date""",
          Map.of("id", id, "from", start, "to", end))
          .stream()
          .map(row -> {
            Map<String,Object> item = new LinkedHashMap<>();
            item.put("statDate", row.get("stat_date"));
            item.put("value", row.get("value"));
            item.put("prevValue", row.get("prev_value"));
            item.put("calcTime", row.get("calc_time"));
            return item;
          })
          .toList();

      DoubleSummaryStatistics stats = values.stream()
          .map(item -> item.get("value"))
          .filter(Number.class::isInstance)
          .mapToDouble(value -> ((Number) value).doubleValue())
          .summaryStatistics();

      Map<String,Object> summary = new LinkedHashMap<>();
      summary.put("count", values.size());
      summary.put("lastDate", values.isEmpty() ? null : values.getLast().get("statDate"));
      summary.put("lastValue", values.isEmpty() ? null : values.getLast().get("value"));
      summary.put("sum", stats.getSum());
      summary.put("avg", values.isEmpty() ? 0 : stats.getAverage());
      summary.put("max", values.isEmpty() ? null : stats.getMax());
      summary.put("min", values.isEmpty() ? null : stats.getMin());

      return ok(Map.of(
          "metric", db.one("select * from bi_metric where id = :id", Map.of("id", id)),
          "from", start,
          "to", end,
          "values", values,
          "summary", summary));
    });
  }

  /** 试算：按当前指标定义算某一天的值，不落库。 */
  @PostMapping("/{id}/preview")
  public Map<String,Object> preview(
      @PathVariable int id,
      @RequestBody(required = false) Map<String,Object> body,
      HttpServletRequest request) {
    return db.tx(user(request), tx -> {
      LocalDate date = body != null && body.get("statDate") != null
          ? LocalDate.parse(String.valueOf(body.get("statDate")))
          : LocalDate.now().minusDays(1);
      Map<String,Object> metric = db.one("select * from bi_metric where id = :id", Map.of("id", id));
      if (metric == null) throw ApiException.notFound("指标不存在");
      return ok(Map.of(
          "statDate", date,
          "value", metrics.compute(metric, date),
          "range", Map.of("from", date, "to", date)));
    });
  }

  /** 补算：把 [from, to] 区间逐日落库，最长 366 天。 */
  @PostMapping("/{id}/compute")
  public Map<String,Object> compute(
      @PathVariable int id,
      @RequestBody(required = false) Map<String,Object> body,
      HttpServletRequest request) {
    UserPrincipal user = user(request);
    design(user);
    return db.tx(user, tx -> {
      LocalDate from = dateArg(body, "from", LocalDate.now().minusDays(1));
      LocalDate to = body != null && body.get("to") != null
          ? LocalDate.parse(String.valueOf(body.get("to")))
          : from;
      if (to.isBefore(from) || to.isAfter(from.plusDays(366))) {
        throw ApiException.bad("补算日期范围无效或超过 366 天");
      }

      Map<String,Object> metric = db.one("select * from bi_metric where id = :id", Map.of("id", id));
      if (metric == null) throw ApiException.notFound("指标不存在");

      int rows = 0;
      for (LocalDate date = from; !date.isAfter(to); date = date.plusDays(1)) {
        metrics.persist(metric, date, null);
        rows++;
      }
      return ok(Map.of("rows", rows), "已计算 " + rows + " 条");
    });
  }

  // ------------------------------------------------------------------ 增删改

  @PostMapping
  public Map<String,Object> create(@RequestBody Map<String,Object> body, HttpServletRequest request) {
    UserPrincipal user = user(request);
    design(user);
    required(body);
    return db.tx(user, tx -> {
      String code = String.valueOf(body.getOrDefault(
          "code", "m_" + Long.toString(System.currentTimeMillis(), 36)));
      Map<String,Object> params = metricParams(body);
      params.put("code", code);
      params.put("owner", user.id());
      Number id = db.insertId("""
          insert into bi_metric(
            code, name, metric_group, report_id, measure_key, agg_fn,
            date_field_key, date_mode, filters, unit, precision, direction,
            description, owner_id, status)
          values(:code, :name, :grp, :report, :measure, :agg,
                 :dateField, :mode, cast(:filters as jsonb), :unit, :precision, :direction,
                 :description, :owner, :status)""",
          params);
      return ok(Map.of("id", id, "code", code), "指标已创建");
    });
  }

  @PutMapping("/{id}")
  public Map<String,Object> update(
      @PathVariable int id, @RequestBody Map<String,Object> body, HttpServletRequest request) {
    UserPrincipal user = user(request);
    design(user);
    required(body);
    return db.tx(user, tx -> {
      Map<String,Object> params = metricParams(body);
      params.put("id", id);
      int changed = db.update("""
          update bi_metric
          set name = :name, metric_group = :grp, report_id = :report,
              measure_key = :measure, agg_fn = :agg, date_field_key = :dateField,
              date_mode = :mode, filters = cast(:filters as jsonb), unit = :unit,
              precision = :precision, direction = :direction, description = :description,
              status = :status, updated_at = now()
          where id = :id""",
          params);
      if (changed == 0) throw ApiException.notFound("指标不存在");
      return ok(null, "已保存");
    });
  }

  @DeleteMapping("/{id}")
  public Map<String,Object> delete(@PathVariable int id, HttpServletRequest request) {
    UserPrincipal user = user(request);
    design(user);
    return db.tx(user, tx -> {
      db.update("delete from bi_metric where id = :id", Map.of("id", id));
      return ok(null, "已删除");
    });
  }

  // ------------------------------------------------------------------ 内部工具

  /** 报表清单 + 每张报表的字段，供指标的"度量字段 / 日期字段"下拉使用。 */
  private List<Map<String,Object>> reports() {
    List<Map<String,Object>> reports = db.many("""
        select r.id, r.code, r.name, r.category, d.name dataset_name
        from rpt_report r
        join rpt_dataset d on d.id = r.dataset_id
        order by r.category, r.id""");
    List<Map<String,Object>> fields = db.many("""
        select report_id, field_key, field_name, field_type, field_role, agg_fn, is_custom
        from rpt_report_field
        order by report_id, sort_no, id""");
    reports.forEach(report -> report.put("fields", fields.stream()
        .filter(field -> Objects.equals(report.get("id"), field.get("report_id")))
        .toList()));
    return reports;
  }

  private static void required(Map<String,Object> body) {
    if (body.get("name") == null
        || body.get("reportId") == null
        || body.get("measureKey") == null
        || body.get("dateFieldKey") == null) {
      throw ApiException.bad("指标名称、数据来源、度量字段与日期字段必填");
    }
  }

  private Map<String,Object> metricParams(Map<String,Object> body) {
    Map<String,Object> params = new LinkedHashMap<>();
    params.put("name", body.get("name"));
    params.put("grp", body.getOrDefault("metricGroup", "自定义"));
    params.put("report", body.get("reportId"));
    params.put("measure", body.get("measureKey"));
    params.put("agg", body.getOrDefault("aggFn", "sum"));
    params.put("dateField", body.get("dateFieldKey"));
    params.put("mode", body.getOrDefault("dateMode", "day"));
    params.put("filters", json(body.getOrDefault("filters", List.of())));
    params.put("unit", body.get("unit"));
    params.put("precision", body.getOrDefault("precision", 0));
    params.put("direction", body.getOrDefault("direction", "up"));
    params.put("description", body.get("description"));
    params.put("status", body.getOrDefault("status", "1"));
    return params;
  }

  private String json(Object value) {
    try {
      return json.writeValueAsString(value);
    } catch (Exception e) {
      throw ApiException.bad("过滤条件格式无效");
    }
  }

  private void design(UserPrincipal user) {
    acl.require(user, "action", "metric:design", "无权限：需要「指标设计」权限");
  }

  /** 把 `value,label,value,label...` 的变长参数转成前端下拉需要的 [{value,label}]。 */
  private static List<Map<String,Object>> pairs(String... values) {
    List<Map<String,Object>> out = new ArrayList<>();
    for (int i = 0; i < values.length; i += 2) {
      out.add(Map.of("value", values[i], "label", values[i + 1]));
    }
    return out;
  }

  /** 取请求体里的日期字段，缺省回退到 fallback（补算接口兼容旧的 statDate 写法）。 */
  private static LocalDate dateArg(Map<String,Object> body, String key, LocalDate fallback) {
    if (body == null) return fallback;
    if (body.get(key) != null) return LocalDate.parse(String.valueOf(body.get(key)));
    if (body.get("statDate") != null) return LocalDate.parse(String.valueOf(body.get("statDate")));
    return fallback;
  }
}
