package com.crazy4lamb.crmbi.controller;

import static com.crazy4lamb.crmbi.controller.AuthController.user;
import static com.crazy4lamb.crmbi.core.Api.ok;

import com.crazy4lamb.crmbi.core.ApiException;
import com.crazy4lamb.crmbi.core.Db;
import com.crazy4lamb.crmbi.core.UserPrincipal;
import com.crazy4lamb.crmbi.service.AclService;
import com.crazy4lamb.crmbi.service.QueryEngine;
import com.crazy4lamb.crmbi.service.QueryEngine.Dataset;
import com.crazy4lamb.crmbi.service.QueryEngine.Filter;
import com.crazy4lamb.crmbi.service.QueryEngine.Request;
import com.crazy4lamb.crmbi.service.QueryEngine.Result;
import com.crazy4lamb.crmbi.service.QueryEngine.Series;
import jakarta.servlet.http.HttpServletRequest;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/dashboard")
public class DashboardController {

  /** 多巴胺配色板，与前端 CSS 变量保持一致。 */
  private static final Map<String,List<String>> PALETTES = Map.of(
      "blue",   List.of("#2ea6ff", "#5bbcff", "#8dd5ff", "#bfeaff", "#e2f6ff"),
      "purple", List.of("#b452ff", "#c480ff", "#d5a4ff", "#e5c9ff", "#f4ebff"),
      "green",  List.of("#00c2a8", "#33d1b8", "#63decc", "#9feee0", "#cff8f3"),
      "orange", List.of("#ff6a1a", "#ff9f45", "#ffc377", "#ffddb0", "#fff1d6"),
      "teal",   List.of("#00c2a8", "#33d6c2", "#66e4d3", "#a0f0e4", "#cff8f3"),
      "red",    List.of("#ff3b5c", "#ff6b85", "#ff94a8", "#ffc0cd", "#ffe2ea"),
      "multi",  List.of("#ff6a1a", "#ff4d8d", "#00c2a8", "#b452ff", "#ffd60a", "#2ea6ff", "#ff5c5c", "#7c3aed"),
      "heat",   List.of("#fff1e0", "#ffd9a8", "#ffb266", "#ff8f3c", "#ff6a1a", "#ff4d8d", "#b452ff"));

  /** 支持的图型。 */
  private static final Set<String> CHART_TYPES =
      Set.of("bar", "bar_h", "line", "area", "pie", "doughnut", "funnel", "radar", "gauge", "scatter", "heatmap");

  private final Db db;
  private final AclService acl;
  private final QueryEngine engine;

  public DashboardController(Db db, AclService acl, QueryEngine engine) {
    this.db = db;
    this.acl = acl;
    this.engine = engine;
  }

  // ------------------------------------------------------------------ 驾驶舱装配

  @GetMapping("/mine")
  public Map<String,Object> mine(@RequestParam(required = false) String dashboard,
                                 HttpServletRequest request) {
    UserPrincipal user = user(request);
    return db.tx(user, ignored -> {
      List<String> codes = acl.permissions(user.role()).getOrDefault("dashboard", List.of());
      if (codes.isEmpty()) {
        return ok(Map.of("dashboards", List.of(), "cards", List.of(), "charts", List.of()));
      }

      List<Map<String,Object>> dashboards = db.many(
          "select * from bi_dashboard where status='1' and code in (:codes) order by sort_no,id",
          Map.of("codes", codes));
      if (dashboards.isEmpty()) {
        return ok(Map.of("dashboards", List.of(), "cards", List.of(), "charts", List.of()));
      }

      Map<String,Object> selected = dashboards.stream()
          .filter(d -> dashboard != null && dashboard.equals(d.get("code")))
          .findFirst()
          .orElse(dashboards.getFirst());

      List<Map<String,Object>> items = db.many(
          "select w.*, dw.col_span, dw.height from bi_dashboard_widget dw"
              + " join bi_widget w on w.id = dw.widget_id where dw.dashboard_id=:id order by dw.sort_no",
          Map.of("id", selected.get("id")));

      List<Map<String,Object>> cards = new ArrayList<>();
      List<Map<String,Object>> charts = new ArrayList<>();
      for (Map<String,Object> widget : items) {
        String type = text(widget.get("widget_type"));
        if (!acl.can(user, "card".equals(type) ? "card" : "chart", text(widget.get("code")))) continue;

        Map<String,Object> item = new LinkedHashMap<>();
        item.put("code", widget.get("code"));
        item.put("name", widget.get("name"));
        item.put("span", widget.get("col_span"));
        item.put("height", widget.get("height"));
        if ("card".equals(type)) {
          item.put("icon", widget.get("icon"));
          item.put("unit", widget.get("unit"));
          item.put("fmt", widget.get("fmt"));
          item.put("source", widget.get("value_mode"));
          item.put("sumMode", widget.get("sum_mode"));
          if (widget.get("style") instanceof Map<?,?> style) item.put("color", style.get("color"));
          cards.add(item);
        } else {
          item.put("chartType", widget.get("chart_type"));
          item.put("scope", widget.get("scope"));
          item.put("reportId", widget.get("report_id"));
          charts.add(item);
        }
      }

      List<Map<String,Object>> dashboardList = dashboards.stream().map(d -> {
        Map<String,Object> item = new LinkedHashMap<>();
        item.put("code", d.get("code"));
        item.put("name", d.get("name"));
        item.put("description", d.get("description"));
        item.put("isDefault", d.get("is_default"));
        return item;
      }).toList();

      Map<String,Object> summary = new LinkedHashMap<>();
      summary.put("code", selected.get("code"));
      summary.put("name", selected.get("name"));
      summary.put("description", text(selected.get("description")));

      return ok(Map.of(
          "dashboards", dashboardList,
          "dashboard", summary,
          "cards", cards,
          "charts", charts,
          "statDate", LocalDate.now().minusDays(1).toString()));
    });
  }

  // ------------------------------------------------------------------ 组件取数

  @GetMapping("/widget/{code}")
  public Map<String,Object> widget(@PathVariable String code, HttpServletRequest request) {
    UserPrincipal user = user(request);
    return db.tx(user, ignored -> {
      Map<String,Object> widget = db.one(
          "select * from bi_widget where code=:code and status='1'", Map.of("code", code));
      if (widget == null) throw ApiException.notFound("组件不存在");
      String type = text(widget.get("widget_type"));
      if (!acl.can(user, "card".equals(type) ? "card" : "chart", code)) {
        throw ApiException.forbidden("当前角色无权查看该组件");
      }
      return ok(render(widget));
    });
  }

  @GetMapping("/widgets")
  public Map<String,Object> widgets(@RequestParam String codes, HttpServletRequest request) {
    UserPrincipal user = user(request);
    return db.tx(user, ignored -> {
      List<String> list = java.util.Arrays.stream(codes.split(","))
          .map(String::trim).filter(v -> !v.isEmpty()).limit(20).toList();
      if (list.isEmpty()) return ok(List.of());

      List<Map<String,Object>> out = new ArrayList<>();
      for (Map<String,Object> widget : db.many(
          "select * from bi_widget where code in (:codes)", Map.of("codes", list))) {
        String type = text(widget.get("widget_type"));
        if (acl.can(user, "card".equals(type) ? "card" : "chart", text(widget.get("code")))) {
          try {
            out.add(render(widget));
          } catch (ApiException invalidWidget) {
            // 单个组件配置异常不应拖垮整张驾驶舱，前端可在对应卡片上显示错误。
            Map<String,Object> failed = new LinkedHashMap<>();
            failed.put("code", widget.get("code"));
            failed.put("name", widget.get("name"));
            failed.put("widgetType", type);
            failed.put("ok", false);
            failed.put("error", invalidWidget.getMessage());
            out.add(failed);
          }
        }
      }
      return ok(out);
    });
  }

  @GetMapping("/widget-library")
  public Map<String,Object> library(HttpServletRequest request) {
    UserPrincipal user = user(request);
    return db.tx(user, ignored -> {
      List<Map<String,Object>> rows =
          db.many("select * from bi_widget where status='1' order by widget_type,sort_no,id");
      return ok(rows.stream()
          .filter(w -> acl.can(user, "card".equals(text(w.get("widget_type"))) ? "card" : "chart", text(w.get("code"))))
          .map(this::widgetMeta)
          .toList());
    });
  }

  /** 经营洞察：应收、逾期商机、待跟进与销售趋势。 */
  @GetMapping("/insights")
  public Map<String,Object> insights(HttpServletRequest request) {
    UserPrincipal user = user(request);
    acl.require(user, "menu", "dashboard", "无权限查看驾驶舱");
    return db.tx(user, ignored -> {
      String from = LocalDate.now().minusDays(29).toString();
      String to = LocalDate.now().toString();

      Map<String,Object> receivables = db.one(
          "select coalesce(sum(unpaid_amount),0) amount,"
              + " count(*) filter(where unpaid_amount>0)::int orders"
              + " from crm_order_balance where status<>'refund'");

      Map<String,Object> opportunities = db.one(
          "select count(*) filter(where expect_date<current_date)::int overdue,"
              + " coalesce(sum(est_amount*win_rate/100.0),0) forecast"
              + " from crm_opportunity where stage not in ('赢单','输单')");

      Map<String,Object> followups = db.one(
          "select count(*) filter(where next_time<=now())::int due"
              + " from crm_follow_up where next_time is not null");

      List<Map<String,Object>> trend = db.many(
              "select * from bi_sales_trend(cast(:from as date),cast(:to as date))",
              Map.of("from", from, "to", to)).stream()
          .map(row -> {
            Map<String,Object> item = new LinkedHashMap<>();
            item.put("date", row.get("stat_date"));
            item.put("amount", row.get("sales_amount"));
            item.put("contracts", row.get("contract_count"));
            item.put("profit", row.get("profit"));
            item.put("runningAmount", row.get("running_amount"));
            item.put("previousAmount", row.get("previous_amount"));
            return item;
          }).toList();

      Map<String,Object> snapshot = db.one(
          "select refreshed_at,source_version,refreshed_version,"
              + " source_version>refreshed_version stale from bi_refresh_state where id=1");

      return ok(Map.of(
          "enabled", true, "from", from, "to", to,
          "receivables", receivables, "opportunities", opportunities,
          "followups", followups, "snapshot", snapshot, "trend", trend));
    });
  }

  // ------------------------------------------------------------------ 渲染

  /** 渲染单个组件（卡片或图表）。 */
  public Map<String,Object> render(Map<String,Object> widget) {
    String type = text(widget.get("widget_type"));
    Map<String,Object> result = new LinkedHashMap<>();
    result.put("code", widget.get("code"));
    result.put("name", widget.get("name"));
    result.put("widgetType", type);
    result.put("ok", true);
    if ("card".equals(type)) {
      result.put("data", card(widget));
    } else {
      result.put("chartType", widget.get("chart_type"));
      result.put("data", chart(widget));
    }
    return result;
  }

  /**
   * 卡片取数。
   *
   * <p>优先读{@code bi_metric_value} 中已落库的 T+1 指标值（并用 {@code prev_value} 算真实环比）；
   * 没有绑定指标时才退回实时聚合。
   */
  private Map<String,Object> card(Map<String,Object> widget) {
    Object metricId = widget.get("metric_id");
    if (metricId instanceof Number id) {
      LocalDate dataDate = latestDataDate(id.intValue());
      Map<String,Object> params = new LinkedHashMap<>();
      params.put("id", id.intValue());
      String sql = "select value, prev_value, stat_date from bi_metric_value where metric_id=:id";
      if (dataDate != null) {
        sql += " and stat_date<=:dataDate";
        params.put("dataDate", dataDate);
      }
      Map<String,Object> row = db.one(sql + " order by stat_date desc limit 1", params);
      if (row != null) return cardFromMetric(row, widget);
    }
    return cardFromQuery(widget);
  }

  /**
   * 指标任务可能已跑到今天，但业务源数据仍停留在更早的日期。卡片应对齐数据集水位，
   * 避免把未来空跑出来的 0 覆盖最后一个真实业务日。
   */
  private LocalDate latestDataDate(int metricId) {
    Map<String,Object> metric = db.one(
        "select report_id from bi_metric where id=:id", Map.of("id", metricId));
    Integer reportId = metric == null ? null : integer(metric.get("report_id"));
    if (reportId == null) return null;

    Dataset dataset = engine.datasetOfReport(reportId);
    String dateKey = dataset.dateField();
    if (!notBlank(dateKey)) return null;
    boolean mapped = engine.reportFields(reportId).stream()
        .anyMatch(field -> dateKey.equals(field.key()));
    if (!mapped) return null;

    Result latest = engine.queryReport(reportId, new Request(
        dataset.id(), List.of(dateKey), List.of(), List.of(),
        "axis", dateKey, "desc", 1, false));
    if (latest.rows().isEmpty()) return null;
    Object value = latest.rows().getFirst().get(dateKey);
    if (value == null) return null;
    String text = String.valueOf(value);
    return LocalDate.parse(text.length() > 10 ? text.substring(0, 10) : text);
  }

  private Map<String,Object> cardFromMetric(Map<String,Object> row, Map<String,Object> widget) {
    BigDecimal value = decimal(row.get("value"));
    BigDecimal previous = decimal(row.get("prev_value"));
    BigDecimal growth = BigDecimal.ZERO;
    String growthText = "—";
    if (previous != null && previous.signum() != 0) {
      growth = value.subtract(previous)
          .divide(previous.abs(), 4, java.math.RoundingMode.HALF_UP)
          .multiply(BigDecimal.valueOf(100));
      growthText = (growth.signum() > 0 ? "+" : "") + growth.setScale(1, java.math.RoundingMode.HALF_UP) + "%";
    }

    Map<String,Object> out = new LinkedHashMap<>();
    out.put("value", value);
    out.put("rawValue", value);
    out.put("display", String.format("%,.0f", value));
    out.put("growth", growth);
    out.put("growthText", growthText);
    out.put("statDate", row.get("stat_date"));
    out.put("spark", metricSpark((Number) widget.get("metric_id"), row.get("stat_date")));
    out.put("unit", widget.get("unit"));
    return out;
  }

  /** 指标近 14 期序列，作为卡片迷你趋势。 */
  private List<Object> metricSpark(Number metricId, Object throughDate) {
    List<Map<String,Object>> rows = db.many(
        "select value from bi_metric_value where metric_id=:id"
            + " and stat_date<=cast(:date as date) order by stat_date desc limit 14",
        Map.of("id", metricId.intValue(), "date", String.valueOf(throughDate)));
    return rows.reversed().stream().map(row -> row.get("value")).toList();
  }

  /**
   * 未绑定指标时的兜底：按组件配置的 report_id + sum_mode 走查询引擎实时出数。
   *
   * <p>sum_mode 语义：
   * <ul>
   *   <li>{@code latest} —— 最近一个有数据的统计日（而不是死板的「昨天」，否则跨零点会取到空值）；</li>
   *   <li>{@code mtd} —— 本月累计；</li>
   *   <li>{@code all} —— 全量汇总。</li>
   * </ul>
   * 数据范围由数据库的 RLS 会话变量决定，组件上的 scope 只作语义标注。
   */
  private Map<String,Object> cardFromQuery(Map<String,Object> widget) {
    BigDecimal value = BigDecimal.ZERO;
    String statDate = null;
    List<Object> spark = List.of();

    Integer reportId = integer(widget.get("report_id"));
    if (reportId != null) {
      Dataset dataset = engine.datasetOfReport(reportId);
      List<QueryEngine.Field> fields = engine.reportFields(reportId);
      List<Map<String,Object>> seriesConfig = mapList(widget.get("series"));
      String configuredMeasure = seriesConfig.isEmpty()
          ? null : text(seriesConfig.getFirst().get("key"), null);
      QueryEngine.Field measure = fields.stream()
          .filter(field -> "measure".equals(field.role()))
          .filter(field -> !notBlank(configuredMeasure) || configuredMeasure.equals(field.key()))
          .findFirst().orElse(null);
      boolean dateMapped = fields.stream()
          .anyMatch(field -> dataset.dateField() != null && dataset.dateField().equals(field.key()));
      String dateKey = dateMapped ? dataset.dateField() : null;
      List<Filter> configuredFilters = widgetFilters(widget);

      if (measure != null) {
        String sumMode = text(widget.get("sum_mode"), "latest");
        String configuredAgg = seriesConfig.isEmpty()
            ? measure.agg() : text(seriesConfig.getFirst().get("agg"), measure.agg());
        List<Series> series = List.of(new Series(measure.key(), configuredAgg, null, null));
        LocalDate today = LocalDate.now();

        if ("latest".equals(sumMode) && dateKey != null) {
          // 取最近一个有数据的统计日
          Result latest = engine.queryReport(reportId, new Request(
              dataset.id(), List.of(dateKey), series, configuredFilters,
              null, dateKey, "desc", 1, false));
          if (!latest.rows().isEmpty()) {
            Map<String,Object> row = latest.rows().getFirst();
            value = decimal(row.get(measure.key()));
            statDate = String.valueOf(row.get(dateKey));
          }
        } else {
          List<Filter> filters = new ArrayList<>(configuredFilters);
          if ("mtd".equals(sumMode) && dateKey != null) {
            filters.add(new Filter(dateKey, "ge", today.withDayOfMonth(1).toString(), null));
          }
          Result all = engine.queryReport(reportId, new Request(
              dataset.id(), List.of(), series, filters, null, null, null, 1, false));
          if (!all.rows().isEmpty()) {
            value = decimal(all.rows().getFirst().get(measure.key()));
          }
          if (dateKey != null) {
            Result newest = engine.queryReport(reportId, new Request(
                dataset.id(), List.of(dateKey), List.of(), configuredFilters,
                null, dateKey, "desc", 1, false));
            if (!newest.rows().isEmpty()) {
              statDate = String.valueOf(newest.rows().getFirst().get(dateKey));
            }
          }
        }

        // 迷你趋势：最近 14 个统计日
        if (dateKey != null) {
          Result trend = engine.queryReport(reportId, new Request(
              dataset.id(), List.of(dateKey), series,
              concatFilters(configuredFilters,
                  new Filter(dateKey, "ge", today.minusDays(20).toString(), null)),
              "axis", null, null, 14, false));
          spark = trend.rows().reversed().stream()
              .map(row -> row.get(measure.key()))
              .map(DashboardController::plain)
              .toList();
        }
      }
    }

    Map<String,Object> out = new LinkedHashMap<>();
    out.put("value", value);
    out.put("rawValue", value);
    out.put("display", String.format("%,.0f", value));
    out.put("growth", BigDecimal.ZERO);
    out.put("growthText", "—");
    out.put("statDate", statDate);
    out.put("spark", spark);
    out.put("unit", widget.get("unit"));
    return out;
  }

  private static boolean notBlank(String value) {
    return value != null && !value.isBlank();
  }

  /**
   * 统计图取数与 option 构造。
   *
   * <p>完全按 {@code bi_widget} 的配置执行：{@code report_id} 决定数据来源，
   * {@code dimension_keys} 决定维度，{@code series} 决定度量与统计方式，
   * {@code filters} 决定过滤，{@code sort_strategy} 决定排序，{@code style} 决定配色与图例。
   */
  private Map<String,Object> chart(Map<String,Object> widget) {
    String chartType = text(widget.get("chart_type"), "bar");
    if (!CHART_TYPES.contains(chartType)) chartType = "bar";
    Map<String,Object> style = asMap(widget.get("style"));

    // 仪表盘：读指标值，不走报表
    if ("gauge".equals(chartType)) {
      return gauge(widget, style);
    }

    Result result = runChartQuery(widget);

    List<String> dims = stringList(widget.get("dimension_keys"));
    List<Map<String,Object>> seriesConfig = mapList(widget.get("series"));
    String splitColumn = result.columns().stream()
        .filter(c -> "split".equals(c.get("role")))
        .map(c -> text(c.get("key")))
        .findFirst().orElse(null);

    Map<String,Object> payload = new LinkedHashMap<>();
    payload.put("columns", result.columns());
    payload.put("rows", result.rows());
    payload.put("total", result.total());
    payload.put("scope", text(widget.get("scope")));
    payload.put("totalRows", result.totalRows());
    payload.put("sql", result.sql());
    payload.put("option", option(chartType, dims, splitColumn, seriesConfig, result, style));
    return payload;
  }

  /** 按组件配置构造查询请求并执行。 */
  private Result runChartQuery(Map<String,Object> widget) {
    Integer reportId = integer(widget.get("report_id"));
    if (reportId == null) throw ApiException.bad("统计图未绑定数据来源报表");

    List<String> dims = stringList(widget.get("dimension_keys"));
    List<Series> series = new ArrayList<>();
    for (Map<String,Object> item : mapList(widget.get("series"))) {
      series.add(new Series(
          text(item.get("key")), text(item.get("agg"), "sum"), text(item.get("name")),
          text(item.get("splitBy"), null)));
    }
    if (dims.isEmpty() && series.isEmpty()) {
      throw ApiException.bad("统计图未配置维度或系列");
    }

    List<Filter> filters = widgetFilters(widget);

    Integer limit = integer(widget.get("limit_rows"));
    Request request = new Request(
        0, dims, series, filters,
        text(widget.get("sort_strategy"), null), null, null,
        limit == null || limit <= 0 ? 200 : Math.min(limit, 500), false);
    return engine.queryReport(reportId, request);
  }

  /** 把组件 JSON 中的过滤条件转换为查询引擎模型。 */
  private static List<Filter> widgetFilters(Map<String,Object> widget) {
    List<Filter> filters = new ArrayList<>();
    for (Map<String,Object> item : mapList(widget.get("filters"))) {
      String key = text(item.get("key"), null);
      if (!notBlank(key)) continue;
      filters.add(new Filter(
          key, text(item.get("op"), "eq"),
          QueryEngine.resolveValue(item.get("value")),
          QueryEngine.resolveValue(item.get("value2"))));
    }
    return List.copyOf(filters);
  }

  private static List<Filter> concatFilters(List<Filter> filters, Filter extra) {
    List<Filter> combined = new ArrayList<>(filters);
    combined.add(extra);
    return List.copyOf(combined);
  }

  /** 仪表盘：读绑定指标的最新值与目标值。 */
  private Map<String,Object> gauge(Map<String,Object> widget, Map<String,Object> style) {
    Object metricId = widget.get("metric_id");
    BigDecimal value = BigDecimal.ZERO;
    String statDate = null;
    if (metricId != null) {
      Map<String,Object> row = db.one(
          "select value, stat_date from bi_metric_value where metric_id=:id order by stat_date desc limit 1",
          Map.of("id", metricId));
      if (row != null) {
        value = decimal(row.get("value"));
        statDate = text(row.get("stat_date"), null);
      }
    }
    BigDecimal target = style.get("target") instanceof Number n
        ? new BigDecimal(n.toString())
        : BigDecimal.ZERO;
    double percent = target.signum() == 0
        ? 0
        : Math.min(100, value.multiply(BigDecimal.valueOf(100))
            .divide(target, 1, java.math.RoundingMode.HALF_UP).doubleValue());

    Map<String,Object> series = new LinkedHashMap<>();
    series.put("type", "gauge");
    series.put("startAngle", 210);
    series.put("endAngle", -30);
    series.put("radius", "92%");
    series.put("center", List.of("50%", "60%"));
    series.put("progress", Map.of("show", true, "width", 14, "roundCap", true));
    series.put("axisLine", Map.of("lineStyle", Map.of("width", 14)));
    series.put("axisTick", Map.of("show", false));
    series.put("splitLine", Map.of("length", 12));
    series.put("axisLabel", Map.of("distance", 16));
    series.put("detail", Map.of("valueAnimation", true, "formatter", "{value}%"));
    series.put("data", List.of(Map.of("value", percent, "name", text(widget.get("name")))));

    Map<String,Object> option = new LinkedHashMap<>();
    option.put("tooltip", Map.of("formatter", "{b}<br/>{c}%"));
    option.put("series", List.of(series));

    Map<String,Object> payload = new LinkedHashMap<>();
    payload.put("columns", List.of());
    payload.put("rows", List.of());
    payload.put("scope", text(widget.get("scope")));
    payload.put("totalRows", value.signum() == 0 ? 0 : 1);
    payload.put("value", value);
    payload.put("target", target);
    payload.put("statDate", statDate);
    payload.put("option", option);
    return payload;
  }

  // ------------------------------------------------------------------ ECharts option

  /** 依据图型构造 ECharts option。 */
  private Map<String,Object> option(String chartType, List<String> dims, String splitColumn,
                                    List<Map<String,Object>> seriesConfig, Result result,
                                    Map<String,Object> style) {
    List<String> palette = palette(style);
    boolean legendTop = "top".equals(text(style.get("legend"), "top"));

    // 维度列的 key 就是字段键本身（引擎里 as <fieldKey>），据此取轴标签
    String categoryKey = result.columns().stream()
        .filter(column -> "dimension".equals(column.get("role")))
        .map(column -> text(column.get("key")))
        .findFirst().orElse(null);

    List<String> axisLabels = categoryKey == null
        ? result.rows().stream().map(row -> "").toList()
        : result.rows().stream().map(row -> text(row.get(categoryKey), "—")).toList();

    List<String> valueKeys = result.columns().stream()
        .filter(column -> "measure".equals(column.get("role")))
        .map(column -> text(column.get("key")))
        .toList();
    List<String> valueNames = result.columns().stream()
        .filter(column -> "measure".equals(column.get("role")))
        .map(column -> text(column.get("name")))
        .toList();
    List<List<Object>> valueMatrix = valueKeys.stream()
        .map(key -> result.rows().stream().map(row -> row.get(key)).map(DashboardController::plain).toList())
        .toList();

    Map<String,Object> option = new LinkedHashMap<>();
    option.put("color", palette);
    option.put("tooltip", Map.of("trigger", chartType.equals("pie") || chartType.equals("funnel")
        || chartType.equals("doughnut") ? "item" : "axis"));
    if (legendTop && chartType.startsWith("bar") == false && valueKeys.size() > 1) {
      option.put("legend", Map.of("top", 8, "type", "scroll"));
    }

    switch (chartType) {
      case "pie", "doughnut" -> {
        option.put("series", List.of(Map.of(
            "type", "pie",
            "radius", chartType.equals("doughnut") ? List.of("45%", "72%") : "62%",
            "center", List.of("50%", "56%"),
            "data", zip(axisLabels, firstValue(valueMatrix)),
            "label", Map.of("formatter", "{b} {d}%")))
        );
      }
      case "funnel" -> {
        option.put("series", List.of(Map.of(
            "type", "funnel",
            "left", "12%", "right", "12%", "top", 20, "bottom", 20,
            "sort", "descending", "gap", 3,
            "label", Map.of("position", "inside"),
            "data", zip(axisLabels, firstValue(valueMatrix)))));
      }
      case "radar" -> {
        double max = maxOf(valueMatrix);
        option.put("radar", Map.of(
            "indicator", axisLabels.stream()
                .map(label -> Map.of("name", label, "max", max > 0 ? max : 100)).toList()));
        option.put("series", List.of(Map.of(
            "type", "radar",
            "data", namedSeries(valueNames, valueMatrix))));
      }
      case "scatter" -> {
        List<List<Object>> points = new ArrayList<>();
        for (int i = 0; i < axisLabels.size(); i++) {
          points.add(List.of(i, valueAt(valueMatrix, 0, i)));
        }
        option.put("xAxis", Map.of("type", "category", "data", axisLabels,
            "axisLabel", Map.of("rotate", 30)));
        option.put("yAxis", Map.of("type", "value"));
        option.put("series", List.of(Map.of("type", "scatter", "symbolSize", 12, "data", points)));
      }
      case "heatmap" -> {
        List<List<Object>> cells = new ArrayList<>();
        for (int x = 0; x < axisLabels.size(); x++) {
          for (int y = 0; y < valueKeys.size(); y++) {
            cells.add(List.of(x, y, number(valueAt(valueMatrix, y, x))));
          }
        }
        option.put("xAxis", Map.of("type", "category", "data", axisLabels,
            "axisLabel", Map.of("rotate", 30)));
        option.put("yAxis", Map.of("type", "category", "data", valueNames));
        option.put("visualMap", Map.of("min", 0, "max", maxOf(valueMatrix),
            "calculable", true, "orient", "vertical", "right", 8, "top", "middle",
            "inRange", Map.of("color", PALETTES.get("heat"))));
        Map<String,Object> heatSeries = new LinkedHashMap<>();
        heatSeries.put("type", "heatmap");
        heatSeries.put("data", cells);
        heatSeries.put("label", Map.of("show", true, "formatter", "heatLabel"));
        option.put("series", List.of(heatSeries));
      }
      case "bar", "bar_h", "line", "area" -> {
        boolean horizontal = chartType.equals("bar_h");
        boolean isLine = chartType.equals("line") || chartType.equals("area");
        boolean stacked = splitColumn != null || Boolean.TRUE.equals(style.get("stack"));
        boolean smooth = Boolean.TRUE.equals(style.get("smooth")) || chartType.equals("area");

        Map<String,Object> categoryAxis = Map.of(
            "type", "category", "data", axisLabels,
            "axisLabel", Map.of("rotate", horizontal ? 0 : (axisLabels.size() > 8 ? 30 : 0)));
        Map<String,Object> valueAxis = Map.of("type", "value");

        option.put(horizontal ? "yAxis" : "xAxis", categoryAxis);
        option.put(horizontal ? "xAxis" : "yAxis", valueAxis);
        option.put("grid", Map.of("left", 56, "right", 24,
            "top", legendTop && valueKeys.size() > 1 ? 44 : 24, "bottom", 40, "containLabel", true));

        List<Map<String,Object>> series = new ArrayList<>();
        if (splitColumn != null) {
          // 堆叠：按拆分维度展开每个度量的一条系列
          List<String> splitValues = distinctSplit(result, splitColumn);
          for (int y = 0; y < valueKeys.size(); y++) {
            String valueKey = valueKeys.get(y);
            String seriesName = valueNames.get(y);
            for (String splitValue : splitValues) {
              List<Object> data = result.rows().stream()
                  .map(row -> text(row.get(splitColumn)).equals(splitValue) ? row.get(valueKey) : 0)
                  .map(DashboardController::plain).toList();
              series.add(cartesian(isLine, smooth, stacked, seriesName + " · " + splitValue, data));
            }
          }
        } else {
          for (int y = 0; y < valueKeys.size(); y++) {
            series.add(cartesian(isLine, smooth, stacked, valueNames.get(y), valueMatrix.get(y)));
          }
        }
        option.put("series", series);
        if (Boolean.TRUE.equals(style.get("showLabel"))) {
          ((List<Map<String,Object>>) option.get("series")).forEach(
              item -> item.put("label", Map.of("show", true, "position", "top")));
        }
      }
      default -> throw ApiException.bad("不支持的图型：" + chartType);
    }
    return option;
  }

  private Map<String,Object> cartesian(boolean isLine, boolean smooth, boolean stacked,
                                      String name, List<Object> data) {
    Map<String,Object> series = new LinkedHashMap<>();
    series.put("name", name);
    series.put("type", isLine ? "line" : "bar");
    series.put("data", data);
    if (isLine) {
      series.put("smooth", smooth);
      series.put("symbol", "circle");
      series.put("symbolSize", 5);
      if (smooth) series.put("areaStyle", Map.of("opacity", 0.15));
    }
    if (stacked) {
      series.put("stack", "total");
      series.put("emphasis", Map.of("focus", "series"));
    }
    return series;
  }

  /** 结果中拆分维度的去重取值，保持出现顺序。 */
  private List<String> distinctSplit(Result result, String splitColumn) {
    Set<String> values = new LinkedHashSet<>();
    for (Map<String,Object> row : result.rows()) values.add(text(row.get(splitColumn), "—"));
    return List.copyOf(values);
  }

  private List<Map<String,Object>> namedSeries(List<String> names, List<List<Object>> matrix) {
    List<Map<String,Object>> out = new ArrayList<>();
    for (int i = 0; i < names.size(); i++) {
      out.add(Map.of("name", names.get(i),
          "value", matrix.get(i).stream().map(DashboardController::plain).toList()));
    }
    return out;
  }

  /** JSONB 列反序列化后是 {@code Map}，此处做一次安全归一。 */
  @SuppressWarnings("unchecked")
  private static Map<String,Object> asMap(Object value) {
    return value instanceof Map<?,?> map ? (Map<String,Object>) map : Map.of();
  }

  // ------------------------------------------------------------------ 工具

  private Map<String,Object> widgetMeta(Map<String,Object> widget) {
    Map<String,Object> item = new LinkedHashMap<>();
    for (String key : List.of("id", "code", "name")) item.put(key, widget.get(key));
    item.put("widgetType", widget.get("widget_type"));
    item.put("chartType", widget.get("chart_type"));
    item.put("reportId", widget.get("report_id"));
    item.put("metricId", widget.get("metric_id"));
    item.put("valueMode", widget.get("value_mode"));
    item.put("scope", widget.get("scope"));
    item.put("sumMode", widget.get("sum_mode"));
    item.put("unit", widget.get("unit"));
    item.put("dims", widget.get("dimension_keys"));
    item.put("series", widget.get("series"));
    item.put("filters", widget.get("filters"));
    item.put("style", widget.get("style"));
    item.put("limit", widget.get("limit_rows"));
    item.put("sortStrategy", widget.get("sort_strategy"));
    item.put("compare", widget.get("compare"));
    item.put("icon", widget.get("icon"));
    return item;
  }

  private static List<String> palette(Map<String,Object> style) {
    Object name = style.get("palette");
    return PALETTES.getOrDefault(text(name, "multi"), PALETTES.get("multi"));
  }

  private static List<Map<String,Object>> zip(List<String> labels, List<Object> values) {
    List<Map<String,Object>> out = new ArrayList<>();
    for (int i = 0; i < labels.size(); i++) {
      out.add(Map.of("name", labels.get(i), "value", i < values.size() ? values.get(i) : 0));
    }
    return out;
  }

  private static List<Object> firstValue(List<List<Object>> matrix) {
    return matrix.isEmpty() ? List.of() : matrix.getFirst();
  }

  private static Object valueAt(List<List<Object>> matrix, int row, int index) {
    if (row >= matrix.size()) return 0;
    List<Object> values = matrix.get(row);
    return index < values.size() ? values.get(index) : 0;
  }

  private static double maxOf(List<List<Object>> matrix) {
    double max = 0;
    for (List<Object> row : matrix) {
      for (Object value : row) max = Math.max(max, number(value));
    }
    return max;
  }

  /** 统一图表数值类型：BigDecimal 转double，其余原样。 */
  private static Object plain(Object value) {
    return value instanceof BigDecimal decimal ? decimal.doubleValue() : value;
  }

  private static double number(Object value) {
    if (value instanceof Number n) return n.doubleValue();
    try {
      return Double.parseDouble(String.valueOf(value));
    } catch (NumberFormatException e) {
      return 0;
    }
  }

  private static BigDecimal decimal(Object value) {
    if (value instanceof BigDecimal decimal) return decimal;
    if (value instanceof Number n) return new BigDecimal(n.toString());
    try {
      return new BigDecimal(String.valueOf(value));
    } catch (NumberFormatException e) {
      return BigDecimal.ZERO;
    }
  }

  private static Integer integer(Object value) {
    if (value instanceof Number n) return n.intValue();
    try {
      return Integer.valueOf(String.valueOf(value));
    } catch (NumberFormatException e) {
      return null;
    }
  }

  private static String text(Object value) {
    return value == null ? "" : String.valueOf(value);
  }

  private static String text(Object value, String fallback) {
    String text = text(value);
    return text.isEmpty() ? fallback : text;
  }

  @SuppressWarnings("unchecked")
  private static List<String> stringList(Object value) {
    if (!(value instanceof List<?> list)) return List.of();
    List<String> out = new ArrayList<>();
    for (Object item : list) {
      String text = text(item);
      if (!text.isEmpty()) out.add(text);
    }
    return out;
  }

  @SuppressWarnings("unchecked")
  private static List<Map<String,Object>> mapList(Object value) {
    if (!(value instanceof List<?> list)) return List.of();
    List<Map<String,Object>> out = new ArrayList<>();
    for (Object item : list) {
      if (item instanceof Map<?,?> map) out.add((Map<String,Object>) map);
    }
    return out;
  }
}
