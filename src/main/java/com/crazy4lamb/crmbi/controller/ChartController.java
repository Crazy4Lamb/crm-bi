package com.crazy4lamb.crmbi.controller;

import static com.crazy4lamb.crmbi.controller.AuthController.user;
import static com.crazy4lamb.crmbi.core.Api.ok;

import com.crazy4lamb.crmbi.core.ApiException;
import com.crazy4lamb.crmbi.core.Db;
import com.crazy4lamb.crmbi.core.UserPrincipal;
import com.crazy4lamb.crmbi.service.AclService;
import com.crazy4lamb.crmbi.service.QueryEngine;
import com.crazy4lamb.crmbi.service.QueryEngine.Request;
import com.crazy4lamb.crmbi.service.QueryEngine.Series;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/chart")
public class ChartController {

  /** 可选调色板，前端设计界面下拉用。 */
  private static final List<Map<String,Object>> PALETTES = List.of(
      option("multi", "多巴胺"), option("purple", "科技紫"), option("blue", "天空蓝"),
      option("green", "薄荷绿"), option("orange", "活力橙"), option("teal", "青碧"),
      option("red", "珊瑚红"), option("heat", "热力"));

  private final Db db;
  private final AclService acl;
  private final DashboardController dashboard;
  private final QueryEngine engine;
  private final ObjectMapper json;

  public ChartController(Db db, AclService acl, DashboardController dashboard,
                         QueryEngine engine, ObjectMapper json) {
    this.db = db;
    this.acl = acl;
    this.dashboard = dashboard;
    this.engine = engine;
    this.json = json;
  }

  // ------------------------------------------------------------------ 元数据

  @GetMapping("/meta")
  public Map<String,Object> meta(HttpServletRequest request) {
    return db.tx(user(request), ignored -> ok(Map.of(
        "chartTypes", pairs(
            "bar", "柱状图", "bar_h", "横向柱状图", "line", "折线图", "area", "面积图",
            "pie", "饼图", "doughnut", "环图", "scatter", "散点图", "heatmap", "热力图",
            "funnel", "漏斗图", "radar", "雷达图", "gauge", "仪表盘"),
        "palettes", PALETTES,
        "aggs", pairs(
            "sum", "求和", "count", "计数", "count_distinct", "去重计数",
            "avg", "平均", "max", "最大", "min", "最小"),
        "sortStrategies", List.of(
            List.of("value_desc", "按值降序"), List.of("value_asc", "按值升序"),
            List.of("axis", "按维度顺序")),
        "scopes", List.of(
            List.of("global", "全量数据"), List.of("dept", "本部门数据"), List.of("self", "仅本人数据")),
        "sumModes", List.of(
            List.of("latest", "当日"), List.of("last30", "近 30 天"), List.of("mtd", "本月累计")),
        "reports", reports())));
  }

  @GetMapping("/list")
  public Map<String,Object> list(HttpServletRequest request) {
    return db.tx(user(request), ignored -> ok(db.many(
        "select w.*, r.name report_name, m.name metric_name"
            + " from bi_widget w"
            + " left join rpt_report r on r.id=w.report_id"
            + " left join bi_metric m on m.id=w.metric_id"
            + " order by w.widget_type,w.id")));
  }

  @GetMapping("/{id}")
  public Map<String,Object> one(@PathVariable int id, HttpServletRequest request) {
    return db.tx(user(request), ignored -> {
      Map<String,Object> widget = db.one("select * from bi_widget where id=:id", Map.of("id", id));
      if (widget == null) throw ApiException.notFound("组件不存在");
      return ok(widget);
    });
  }

  // ------------------------------------------------------------------ 取数

  @GetMapping("/{id}/data")
  public Map<String,Object> data(@PathVariable int id, HttpServletRequest request) {
    return db.tx(user(request), ignored -> {
      Map<String,Object> widget = db.one("select * from bi_widget where id=:id", Map.of("id", id));
      if (widget == null) throw ApiException.notFound("组件不存在");
      return ok(dashboard.render(widget).get("data"));
    });
  }

  /** 设计界面预览：用前端传来的配置直接渲染，不落库。 */
  @PostMapping("/preview")
  public Map<String,Object> preview(@RequestBody Map<String,Object> body, HttpServletRequest request) {
    Map<String,Object> widget = new LinkedHashMap<>();
    widget.put("code", "preview");
    widget.put("name", body.getOrDefault("name", "预览"));
    widget.put("widget_type", "chart");
    widget.put("chart_type", body.getOrDefault("chartType", "bar"));
    widget.put("scope", body.getOrDefault("scope", "global"));
    widget.put("report_id", body.get("reportId"));
    widget.put("metric_id", body.get("metricId"));
    widget.put("dimension_keys", body.get("dims"));
    widget.put("series", body.get("series"));
    widget.put("filters", body.get("filters"));
    widget.put("sort_strategy", body.get("sortStrategy"));
    widget.put("limit_rows", body.get("limit"));
    widget.put("style", body.get("style"));
    widget.put("unit", body.get("unit"));
    return db.tx(user(request), ignored -> {
      try {
        return ok(dashboard.render(widget).get("data"));
      } catch (ApiException e) {
        return ok(Map.of("columns", List.of(), "rows", List.of(), "option", Map.of(), "error", e.getMessage()));
      }
    });
  }

  /** 按报表取样：返回该报表前几个分组结果，供设计界面预览维度与度量。 */
  @GetMapping("/sample/{reportId}")
  public Map<String,Object> sample(@PathVariable int reportId, HttpServletRequest request) {
    return db.tx(user(request), ignored -> {
      List<QueryEngine.Field> fields = engine.reportFields(reportId);
      List<String> dims = fields.stream()
          .filter(field -> "dimension".equals(field.role())).map(QueryEngine.Field::key).toList();
      List<Series> series = fields.stream()
          .filter(field -> "measure".equals(field.role()))
          .map(field -> new Series(field.key(), "sum", field.name(), null))
          .toList();
      if (dims.isEmpty() || series.isEmpty()) {
        return ok(Map.of("columns", List.of(), "rows", List.of()));
      }
      QueryEngine.Result result =
          engine.queryReport(reportId, new Request(0, dims, series, List.of(), "value_desc", null, null, 20, false));
      return ok(Map.of("columns", result.columns(), "rows", result.rows(), "sql", result.sql()));
    });
  }

  // ------------------------------------------------------------------ 设计

  @PostMapping
  public Map<String,Object> create(@RequestBody Map<String,Object> body, HttpServletRequest request) {
    UserPrincipal user = user(request);
    requireDesign(user);
    return db.tx(user, ignored -> {
      String code = text(body.get("code"), "chart_" + Long.toString(System.currentTimeMillis(), 36));
      Number id = db.insertId(
          "insert into bi_widget(code,name,widget_type,chart_type,report_id,dimension_keys,series,"
              + "filters,sort_strategy,limit_rows,scope,style,unit,status)"
              + " values(:code,:name,'chart',:chart,:report,cast(:dims as jsonb),cast(:series as jsonb),"
              + "cast(:filters as jsonb),:sort,:limit,:scope,cast(:style as jsonb),:unit,'1')",
          widgetParams(body, code, null));
      db.update("insert into sys_acl(role_code,res_type,res_key) values(:role,'chart',:code)"
          + " on conflict do nothing", Map.of("role", user.role(), "code", code));
      return ok(Map.of("id", id, "code", code), "统计图已创建");
    });
  }

  @PutMapping("/{id}")
  public Map<String,Object> update(@PathVariable int id, @RequestBody Map<String,Object> body,
                                   HttpServletRequest request) {
    UserPrincipal user = user(request);
    requireDesign(user);
    return db.tx(user, ignored -> {
      Map<String,Object> old = db.one(
          "select code from bi_widget where id=:id and widget_type='chart'", Map.of("id", id));
      if (old == null) throw ApiException.notFound("统计图不存在");
      db.update(
          "update bi_widget set name=:name,chart_type=:chart,report_id=:report,"
              + "dimension_keys=cast(:dims as jsonb),series=cast(:series as jsonb),"
              + "filters=cast(:filters as jsonb),sort_strategy=:sort,limit_rows=:limit,"
              + "scope=:scope,style=cast(:style as jsonb),unit=:unit,updated_at=now() where id=:id",
          widgetParams(body, text(old.get("code")), id));
      return ok(null, "已保存");
    });
  }

  @DeleteMapping("/{id}")
  public Map<String,Object> delete(@PathVariable int id, HttpServletRequest request) {
    UserPrincipal user = user(request);
    requireDesign(user);
    return db.tx(user, ignored -> {
      Map<String,Object> widget = db.one(
          "select code from bi_widget where id=:id and widget_type='chart'", Map.of("id", id));
      if (widget == null) throw ApiException.notFound("统计图不存在");
      db.update("delete from bi_widget where id=:id", Map.of("id", id));
      db.update("delete from sys_acl where res_type='chart' and res_key=:code",
          Map.of("code", widget.get("code")));
      return ok(null, "已删除");
    });
  }

  // ------------------------------------------------------------------ 工具

  /** 报表清单附带字段设计，供设计界面选择维度与度量。 */
  private List<Map<String,Object>> reports() {
    List<Map<String,Object>> reports = db.many(
        "select r.id,r.code,r.name,r.category,d.name dataset_name"
            + " from rpt_report r join rpt_dataset d on d.id=r.dataset_id order by r.category,r.id");
    List<Map<String,Object>> fields = db.many(
        "select report_id,field_key,field_name,field_type,field_role,agg_fn,is_custom"
            + " from rpt_report_field order by report_id,sort_no,id");
    reports.forEach(report ->
        report.put("fields", fields.stream()
            .filter(field -> Objects.equals(report.get("id"), field.get("report_id")))
            .toList()));
    return reports;
  }

  private Map<String,Object> widgetParams(Map<String,Object> body, String code, Integer id) {
    Map<String,Object> params = new LinkedHashMap<>();
    params.put("id", id);
    params.put("code", code);
    params.put("name", body.getOrDefault("name", "未命名统计图"));
    params.put("chart", body.getOrDefault("chartType", "bar"));
    params.put("report", body.get("reportId"));
    params.put("dims", toJson(body.getOrDefault("dims", List.of())));
    params.put("series", toJson(body.getOrDefault("series", List.of())));
    params.put("filters", toJson(body.getOrDefault("filters", List.of())));
    params.put("sort", body.getOrDefault("sortStrategy", "value_desc"));
    params.put("limit", body.getOrDefault("limit", 20));
    params.put("scope", body.getOrDefault("scope", "global"));
    params.put("style", toJson(body.getOrDefault("style", Map.of())));
    params.put("unit", body.get("unit"));
    return params;
  }

  private void requireDesign(UserPrincipal user) {
    acl.require(user, "action", "widget:design", "无权限：需要「统计图设计」权限");
  }

  private String toJson(Object value) {
    try {
      return json.writeValueAsString(value);
    } catch (Exception e) {
      throw ApiException.bad("配置格式无效");
    }
  }

  private static Map<String,Object> option(String value, String label) {
    return Map.of("value", value, "label", label);
  }

  private static List<Map<String,Object>> pairs(String... values) {
    List<Map<String,Object>> out = new ArrayList<>();
    for (int i = 0; i < values.length; i += 2) {
      out.add(Map.of("value", values[i], "label", values[i + 1]));
    }
    return out;
  }

  private static String text(Object value) {
    return value == null ? "" : String.valueOf(value);
  }

  private static String text(Object value, String fallback) {
    String text = text(value);
    return text.isEmpty() ? fallback : text;
  }
}