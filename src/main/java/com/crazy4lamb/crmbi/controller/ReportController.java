package com.crazy4lamb.crmbi.controller;

import static com.crazy4lamb.crmbi.controller.AuthController.user;
import static com.crazy4lamb.crmbi.core.Api.ok;

import com.crazy4lamb.crmbi.core.ApiException;
import com.crazy4lamb.crmbi.core.Db;
import com.crazy4lamb.crmbi.core.UserPrincipal;
import com.crazy4lamb.crmbi.service.AclService;
import com.crazy4lamb.crmbi.service.QueryEngine;
import com.crazy4lamb.crmbi.service.QueryEngine.Dataset;
import com.crazy4lamb.crmbi.service.QueryEngine.Field;
import com.crazy4lamb.crmbi.service.QueryEngine.Filter;
import com.crazy4lamb.crmbi.service.QueryEngine.Request;
import com.crazy4lamb.crmbi.service.QueryEngine.Result;
import com.crazy4lamb.crmbi.service.QueryEngine.Series;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.math.BigDecimal;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
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
@RequestMapping("/api/report")
public class ReportController {

  /** 明细模式允许过滤的字段，其余一律拒绝，避免拼出任意列。 */
  private static final Set<String> DETAIL_FILTERABLE =
      Set.of("status", "region", "industry", "owner_id", "customer_id");

  private final Db db;
  private final AclService acl;
  private final QueryEngine engine;

  public ReportController(Db db, AclService acl, QueryEngine engine) {
    this.db = db;
    this.acl = acl;
    this.engine = engine;
  }

  // ------------------------------------------------------------------ 元数据

  @GetMapping("/meta")
  public Map<String,Object> meta(HttpServletRequest request) {
    return db.tx(user(request), ignored -> {
      List<Map<String,Object>> datasets = db.many(
          "select id,code,name,base_table,date_field,owner_field,dept_field,description"
              + " from rpt_dataset where status='1' order by id");
      List<Map<String,Object>> fields =
          db.many("select * from rpt_dataset_field order by dataset_id,sort_no,id");
      datasets.forEach(dataset ->
          dataset.put("fields", fields.stream()
              .filter(field -> dataset.get("id").equals(field.get("dataset_id")))
              .toList()));

      return ok(Map.of(
          "datasets", datasets,
          "aggs", pairs(
              "none", "原值", "count", "计数", "count_distinct", "去重计数",
              "sum", "求和", "avg", "平均", "max", "最大", "min", "最小"),
          "ops", pairs(
              "eq", "等于", "ne", "不等于", "gt", "大于", "ge", "大于等于",
              "lt", "小于", "le", "小于等于", "like", "包含",
              "between", "区间", "isnull", "为空", "notnull", "不为空"),
          "categories", List.of("销售", "客户", "线索", "合同", "订单", "产品", "财务"),
          "fieldTypes", pairs(
              "string", "文本", "number", "数值", "date", "日期", "datetime", "时间", "bool", "布尔"),
          "roles", pairs("dimension", "维度", "measure", "度量"),
          "formats", List.of(
              List.of("", "默认"), List.of("number", "整数"),
              List.of("currency", "金额"), List.of("percent", "百分比"))));
    });
  }

  @GetMapping("/list")
  public Map<String,Object> list(HttpServletRequest request) {
    return db.tx(user(request), ignored -> ok(db.many(
        "select r.*, d.name dataset_name, d.code dataset_code,"
            + " (select count(*)::int from rpt_report_field f where f.report_id=r.id) field_count"
            + " from rpt_report r join rpt_dataset d on d.id=r.dataset_id order by r.category,r.id")));
  }

  @GetMapping("/{id}")
  public Map<String,Object> detail(@PathVariable int id, HttpServletRequest request) {
    return db.tx(user(request), ignored -> {
      Map<String,Object> report = db.one("select * from rpt_report where id=:id", Map.of("id", id));
      if (report == null) throw ApiException.notFound("报表不存在");
      Map<String,Object> dataset =
          db.one("select * from rpt_dataset where id=:id", Map.of("id", report.get("dataset_id")));
      List<Map<String,Object>> fields = db.many(
          "select * from rpt_report_field where report_id=:id order by sort_no,id", Map.of("id", id));
      List<Map<String,Object>> filters = db.many(
          "select * from rpt_report_filter where report_id=:id order by sort_no,id", Map.of("id", id));

      List<Map<String,Object>> columns = fields.stream().map(field -> {
        Map<String,Object> column = new LinkedHashMap<>();
        column.put("key", field.get("field_key"));
        column.put("name", field.get("field_name"));
        column.put("type", field.get("field_type"));
        column.put("role", field.get("field_role"));
        column.put("agg", field.get("agg_fn"));
        column.put("isCustom", field.get("is_custom"));
        column.put("groupBy", field.get("is_group_by"));
        column.put("width", field.get("width"));
        return column;
      }).toList();

      return ok(Map.of("report", report, "dataset", dataset, "fields", fields,
          "filters", filters, "columnMeta", columns));
    });
  }

  // ------------------------------------------------------------------ 执行

  @PostMapping("/run")
  public Map<String,Object> run(@RequestBody Map<String,Object> body, HttpServletRequest request) {
    Integer reportId = integer(body.get("reportId"));
    if (reportId == null) throw ApiException.bad("缺少 reportId");
    return db.tx(user(request), ignored -> ok(runReport(reportId, body)));
  }

  /**
   * 报表执行：完全依据 {@code rpt_report_field} 的字段设计出数。
   *
   * <p>存在 {@code is_group_by=true} 的字段时走分组聚合模式（附带小计与分页）；
   * 否则走明细模式（按数据集主表分页 + 总行数）。
   */
  private Map<String,Object> runReport(int reportId, Map<String,Object> body) {
    List<Filter> filters = parseFilters(body.get("filters"));
    int size = clamp(integerOr(body.get("size"), integerOr(body.get("limit"), 100)), 1, 500);
    int page = Math.max(1, integerOr(body.get("page"), 1));

    Dataset dataset = engine.datasetOfReport(reportId);
    List<Field> fields = engine.reportFields(reportId);
    if (fields.isEmpty()) throw ApiException.bad("报表还没有字段设计");

    List<String> dims = fields.stream()
        .filter(field -> groupBy(field, body))
        .map(Field::key)
        .toList();

    if (dims.isEmpty()) {
      return runDetail(reportId, dataset, fields, filters, size, page, body);
    }
    return runGrouped(reportId, dataset, fields, dims, filters, size, page, body);
  }

  /** 分组聚合模式。 */
  private Map<String,Object> runGrouped(int reportId, Dataset dataset, List<Field> fields,
                                         List<String> dims, List<Filter> filters, int size, int page,
                                         Map<String,Object> body) {
    // 度量：报表中标记为 measure 的字段，按各自 agg_fn 聚合
    List<Series> series = new ArrayList<>();
    for (Field field : fields) {
      if (!"measure".equals(field.role())) continue;
      if (dims.contains(field.key())) continue;
      series.add(new Series(field.key(), field.agg(), field.name(), null));
    }
    if (series.isEmpty()) throw ApiException.bad("报表没有可聚合的度量字段");

    String orderKey = orderKey(body, dims);
    String orderDir = "asc".equalsIgnoreCase(text(body.get("orderDir"), "desc")) ? "asc" : "desc";

    Request request = new Request(
        dataset.id(), dims, series, filters,
        text(body.get("sortStrategy"), "value_desc"), orderKey, orderDir, 0,
        !Boolean.FALSE.equals(body.get("withTotal")));
    //走报表字段（含自定义字段），而不是数据集字段
    Result result = engine.queryReport(reportId, request);

    // 全量取数用于统计总行数与分页切片
    List<Map<String,Object>> allRows = result.rows();
    int from = Math.min((page - 1) * size, allRows.size());
    int to = Math.min(from + size, allRows.size());
    List<Map<String,Object>> rows = allRows.subList(from, to);

    // 小计基于当前页
    Map<String,Object> total = new LinkedHashMap<>();
    if (!Boolean.FALSE.equals(body.get("withTotal"))) {
      for (Map<String,Object> column : result.columns()) {
        String key = text(column.get("key"));
        if (!"measure".equals(column.get("role"))) continue;
        BigDecimal sum = BigDecimal.ZERO;
        boolean any = false;
        for (Map<String,Object> row : rows) {
          BigDecimal value = decimal(row.get(key));
          if (value == null) continue;
          sum = sum.add(value);
          any = true;
        }
        if (any) total.put(key, sum);
      }
    }

    Map<String,Object> out = new LinkedHashMap<>();
    out.put("rows", rows);
    out.put("columns", result.columns());
    out.put("totalRows", result.totalRows());
    out.put("page", page);
    out.put("size", size);
    out.put("total", total);
    out.put("dataset", datasetInfo(dataset));
    out.put("scope", text(body.getOrDefault("scope", "global"), "global"));
    out.put("grouped", true);
    out.put("withTotal", !Boolean.FALSE.equals(body.get("withTotal")));
    out.put("sql", result.sql());
    out.put("expressions", new LinkedHashMap<>(engine.expressions(dataset, fields).raw()));
    return out;
  }

  /** 明细模式：无分组字段时按主表分页。 */
  private Map<String,Object> runDetail(int reportId, Dataset dataset, List<Field> fields,
                                       List<Filter> filters, int size, int page,
                                       Map<String,Object> body) {
    QueryEngine.Expressions expressions = engine.expressions(dataset, fields);
    Map<String,String> exprs = expressions.raw();
    List<String> selects = new ArrayList<>();
    for (Field field : fields) {
      String expr = exprs.get(field.key());
      if (expr == null) continue;
      selects.add(expr + " as " + QueryEngine.identifier(field.key()));
    }
    if (selects.isEmpty()) throw ApiException.bad("报表字段没有映射到数据集");

    Map<String,Object> params = new LinkedHashMap<>();
    StringBuilder where = new StringBuilder(" where true");
    int n = 0;
    for (Filter filter : filters) {
      if (!DETAIL_FILTERABLE.contains(filter.fieldKey()) && !exprs.containsKey(filter.fieldKey())) {
        throw ApiException.bad("过滤字段不存在：" + filter.fieldKey());
      }
      String expr = exprs.get(filter.fieldKey());
      if (expr == null) throw ApiException.bad("过滤字段不存在：" + filter.fieldKey());
      String op = text(filter.op(), "eq").toLowerCase();
      boolean dateField = expressions.isDate(filter.fieldKey());
      if ("isnull".equals(op)) { where.append(" and ").append(expr).append(" is null"); continue; }
      if ("notnull".equals(op)) { where.append(" and ").append(expr).append(" is not null"); continue; }
      if ("between".equals(op)) {
        params.put("lo" + n, filter.value());
        params.put("hi" + n, filter.value2());
        where.append(" and ").append(expr);
        if (dateField) {
          where.append(" between cast(:lo").append(n).append(" as date) and cast(:hi")
              .append(n).append(" as date)");
        } else {
          where.append(" between :lo").append(n).append(" and :hi").append(n);
        }
        n++;
        continue;
      }
      String name = "f" + n++;
      String sqlOp = QueryEngine.comparison(op);
      if ("like".equals(op)) {
        params.put(name, "%" + filter.value() + "%");
      } else if ("in".equals(op)) {
        params.put(name, inValues(filter.value()));
      } else {
        params.put(name, filter.value());
      }
      where.append(" and ").append(expr).append(' ').append(sqlOp);
      if ("in".equals(op)) {
        where.append(" (:").append(name).append(')');
      } else {
        where.append(dateField ? " cast(:" + name + " as date)" : " :" + name);
      }
    }

    String alias = dataset.baseAlias();
    String base = dataset.baseTable() + " " + alias;
    String joins = dataset.joins().stream()
        .map(join -> ("inner".equalsIgnoreCase(join.type()) ? " inner join " : " left join ")
            + join.table() + " " + join.alias() + " on " + join.on())
        .reduce("", String::concat);

    String countSql = "select count(*) total from " + base + joins + where;
    long totalRows = ((Number) db.one(countSql, params).get("total")).longValue();

    params.put("limit", size);
    params.put("offset", (page - 1) * size);
    String sql = "select " + String.join(", ", selects) + " from " + base + joins + where
        + orderByText(body, exprs.keySet().isEmpty() ? Set.of() : exprs.keySet())
        + " limit :limit offset :offset";
    List<Map<String,Object>> rows = db.many(sql, params);

    List<Map<String,Object>> columns = fields.stream()
        .filter(field -> exprs.containsKey(field.key()))
        .map(field -> Map.<String,Object>of(
            "key", field.key(), "name", field.name(), "role", field.role(), "type", field.type()))
        .toList();

    Map<String,Object> out = new LinkedHashMap<>();
    out.put("rows", rows);
    out.put("columns", columns);
    out.put("totalRows", totalRows);
    out.put("page", page);
    out.put("size", size);
    out.put("dataset", datasetInfo(dataset));
    out.put("scope", text(body.getOrDefault("scope", "global"), "global"));
    out.put("grouped", false);
    out.put("withTotal", false);
    out.put("sql", sql);
    out.put("expressions", exprs);
    return out;
  }

  // ------------------------------------------------------------------ 导出

  @GetMapping("/{id}/export")
  public ResponseEntity<byte[]> export(@PathVariable int id,
                                       @RequestParam(required = false) String scope,
                                       HttpServletRequest request) throws IOException {
    Map<String,Object> result = db.tx(user(request), ignored ->
        runReport(id, Map.of("scope", scope == null ? "global" : scope, "size", 100000)));

    @SuppressWarnings("unchecked")
    List<Map<String,Object>> columns = (List<Map<String,Object>>) result.get("columns");
    @SuppressWarnings("unchecked")
    List<Map<String,Object>> rows = (List<Map<String,Object>>) result.get("rows");

    StringBuilder csv = new StringBuilder("﻿");
    csv.append(columns.stream()
        .map(column -> escape(text(column.get("name"), text(column.get("key")))))
        .reduce((a, b) -> a + "," + b).orElse(""));
    csv.append("\r\n");
    for (Map<String,Object> row : rows) {
      csv.append(columns.stream()
          .map(column -> escape(text(row.get(text(column.get("key"))))))
          .reduce((a, b) -> a + "," + b).orElse(""));
      csv.append("\r\n");
    }

    String name = "report-" + id + "-" + LocalDate.now() + ".csv";
    byte[] body = csv.toString().getBytes(StandardCharsets.UTF_8);
    return ResponseEntity.ok()
        .header(HttpHeaders.CONTENT_DISPOSITION,
            "attachment; filename=\"" + name + "\"; filename*=UTF-8''"
                + URLEncoder.encode(name, StandardCharsets.UTF_8))
        .contentType(MediaType.parseMediaType("text/csv; charset=UTF-8"))
        .body(body);
  }

  /** CSV 转义，并防止以 = + - @ 开头的值被电子表格当作公式执行。 */
  private static String escape(String value) {
    String text = value.replace("\"", "\"\"");
    if (!text.isEmpty() && "=+-@".indexOf(text.charAt(0)) >= 0) {
      return "\"" + "'" + text + "\"";
    }
    return "\"" + text + "\"";
  }

  // ------------------------------------------------------------------ 设计

  @PostMapping
  public Map<String,Object> create(@RequestBody Map<String,Object> body, HttpServletRequest request) {
    UserPrincipal user = user(request);
    requireDesign(user);
    if (body.get("name") == null || body.get("datasetId") == null) {
      throw ApiException.bad("报表名称与数据集必填");
    }
    return db.tx(user, ignored -> {
      String code = text(body.get("code"), "rpt_" + Long.toString(System.currentTimeMillis(), 36));
      Number id = db.insertId(
          "insert into rpt_report(code,name,category,dataset_id,description,owner_id,status,is_public)"
              + " values(:code,:name,:category,:dataset,:description,:owner,'1',true)",
          params("code", code, "name", body.get("name"),
              "category", body.getOrDefault("category", "自定义"),
              "dataset", body.get("datasetId"),
              "description", body.get("description"),
              "owner", user.id()));
      return ok(Map.of("id", id, "code", code), "报表已创建，请继续设计字段");
    });
  }

  @PutMapping("/{id}")
  public Map<String,Object> update(@PathVariable int id, @RequestBody Map<String,Object> body,
                                   HttpServletRequest request) {
    UserPrincipal user = user(request);
    requireDesign(user);
    return db.tx(user, ignored -> {
      int changed = db.update(
          "update rpt_report set name=coalesce(:name,name),category=coalesce(:category,category),"
              + " description=coalesce(:description,description),updated_at=now() where id=:id",
          params("name", body.get("name"), "category", body.get("category"),
              "description", body.get("description"), "id", id));
      if (changed == 0) throw ApiException.notFound("报表不存在");

      if (body.get("fields") instanceof List<?> fields) {
        db.update("delete from rpt_report_field where report_id=:id", Map.of("id", id));
        int sort = 0;
        for (Object item : fields) {
          if (!(item instanceof Map<?,?> field)) continue;
          String key = text(field.get("fieldKey"));
          if (!key.matches("[A-Za-z_][A-Za-z0-9_]*")) {
            throw ApiException.bad("字段标识只能包含字母、数字与下划线");
          }
          String customExpr = field.get("customExpr") == null ? null : String.valueOf(field.get("customExpr"));
          if (customExpr != null && !customExpr.matches("[A-Za-z0-9_ .()+\\-*/%<>=,{}:']+")) {
            throw ApiException.bad("自定义公式包含非法字符");
          }
          db.update(
              "insert into rpt_report_field(report_id,field_key,field_name,field_type,field_role,"
                  + "dataset_field_key,agg_fn,custom_expr,is_group_by,is_show,is_custom,"
                  + "sort_dir,fmt,sort_no)"
                  + " values(:report,:key,:name,:type,:role,:dataset,:agg,:expr,:grouped,:show,"
                  + ":custom,:sort,:fmt,:sortNo)",
              params("report", id, "key", key, "name", field.get("fieldName"),
                  "type", field.get("fieldType"), "role", field.get("fieldRole"),
                  "dataset", field.get("datasetFieldKey"), "agg", field.get("aggFn"),
                  "expr", customExpr, "grouped", Boolean.TRUE.equals(field.get("isGroupBy")),
                  "show", !Boolean.FALSE.equals(field.get("isShow")),
                  "custom", Boolean.TRUE.equals(field.get("isCustom")),
                  "sort", field.get("sortDir") == null ? "none" : field.get("sortDir"),
                  "fmt", field.get("fmt"), "sortNo", ++sort * 10));
        }
      }

      if (body.get("filters") instanceof List<?> filters) {
        db.update("delete from rpt_report_filter where report_id=:id", Map.of("id", id));
        int sort = 0;
        for (Object item : filters) {
          if (!(item instanceof Map<?,?> filter)) continue;
          String key = text(filter.get("fieldKey"));
          if (!key.matches("[A-Za-z_][A-Za-z0-9_]*")) {
            throw ApiException.bad("过滤字段标识无效");
          }
          db.update(
              "insert into rpt_report_filter(report_id,field_key,op,value,value2,logic,sort_no)"
                  + " values(:report,:key,:op,:value,:value2,'and',:sort)",
              params("report", id, "key", key, "op", filter.get("op"),
                  "value", filter.get("value"), "value2", filter.get("value2"), "sort", ++sort));
        }
      }

      return ok(null, "报表已保存");
    });
  }

  @PostMapping("/{id}/duplicate")
  public Map<String,Object> duplicate(@PathVariable int id, HttpServletRequest request) {
    UserPrincipal user = user(request);
    requireDesign(user);
    return db.tx(user, ignored -> {
      Map<String,Object> report = db.one("select * from rpt_report where id=:id", Map.of("id", id));
      if (report == null) throw ApiException.notFound("报表不存在");
      String code = report.get("code") + "_copy_" + Long.toString(System.currentTimeMillis(), 36);
      Number next = db.insertId(
          "insert into rpt_report(code,name,category,dataset_id,description,owner_id,status,is_public)"
              + " values(:code,:name,:category,:dataset,:description,:owner,'1',true)",
          params("code", code, "name", report.get("name") + "（副本）",
              "category", report.get("category"), "dataset", report.get("dataset_id"),
              "description", report.get("description"), "owner", user.id()));
      db.update(
          "insert into rpt_report_field(report_id,field_key,field_name,field_type,field_role,"
              + "dataset_field_key,agg_fn,custom_expr,is_group_by,is_show,is_custom,sort_dir,fmt,width,sort_no)"
              + " select :next,field_key,field_name,field_type,field_role,dataset_field_key,agg_fn,"
              + "custom_expr,is_group_by,is_show,is_custom,sort_dir,fmt,width,sort_no"
              + " from rpt_report_field where report_id=:id",
          Map.of("next", next, "id", id));
      return ok(Map.of("id", next, "code", code), "已复制报表");
    });
  }

  @DeleteMapping("/{id}")
  public Map<String,Object> delete(@PathVariable int id, HttpServletRequest request) {
    UserPrincipal user = user(request);
    requireDesign(user);
    return db.tx(user, ignored -> {
      db.update("delete from rpt_report where id=:id", Map.of("id", id));
      return ok(null, "已删除");
    });
  }

  // ------------------------------------------------------------------ 工具

  private void requireDesign(UserPrincipal user) {
    acl.require(user, "action", "report:design", "无权限：需要「报表设计」权限");
  }

  /**
   * 分组字段判定。
   *
   * <p>以字段自身的 {@code is_group_by} 为准（请求体 {@code groupBy} 可覆盖）。
   * 一个字段都没标记分组时视为明细报表 —— 明细表通常维度很多但不需要聚合。
   */
  private boolean groupBy(Field field, Map<String,Object> body) {
    Object explicit = body.get("groupBy");
    if (explicit instanceof List<?> list) return list.contains(field.key());
    return field.groupBy();
  }

  private List<Filter> parseFilters(Object raw) {
    if (!(raw instanceof List<?> list)) return List.of();
    List<Filter> filters = new ArrayList<>();
    for (Object item : list) {
      if (!(item instanceof Map<?,?> map)) continue;
      String key = text(map.get("fieldKey"));
      if (key.isEmpty()) continue;
      if (!key.matches("[A-Za-z_][A-Za-z0-9_]*")) {
        throw ApiException.bad("过滤字段不存在：" + key);
      }
      filters.add(new Filter(key, text(map.get("op"), "eq"),
          QueryEngine.resolveValue(map.get("value")),
          QueryEngine.resolveValue(map.get("value2"))));
    }
    return filters;
  }

  private String orderKey(Map<String,Object> body, List<String> dims) {
    if (body.get("orderBy") instanceof List<?> orders && !orders.isEmpty()
        && orders.getFirst() instanceof Map<?,?> order) {
      String key = text(order.get("key"));
      if (!key.isEmpty()) return key;
    }
    String strategy = text(body.get("sortStrategy"));
    if ("value_desc".equals(strategy) || "value_asc".equals(strategy)) return null;
    return dims.isEmpty() ? null : dims.getFirst();
  }

  private String orderByText(Map<String,Object> body, Set<String> allowed) {
    if (!(body.get("orderBy") instanceof List<?> orders) || orders.isEmpty()) return "";
    if (!(orders.getFirst() instanceof Map<?,?> order)) return "";
    String key = text(order.get("key"));
    if (key.isEmpty() || !allowed.contains(key)) {
      throw ApiException.bad("排序字段不存在");
    }
    String dir = "asc".equalsIgnoreCase(text(order.get("dir"), "desc")) ? "asc" : "desc";
    return " order by " + QueryEngine.identifier(key) + " " + dir + " nulls last";
  }

  private Map<String,Object> datasetInfo(Dataset dataset) {
    Map<String,Object> info = new LinkedHashMap<>();
    info.put("id", dataset.id());
    info.put("code", dataset.code());
    info.put("name", dataset.name());
    info.put("base_table", dataset.baseTable());
    return info;
  }

  private static List<Map<String,Object>> pairs(String... values) {
    List<Map<String,Object>> out = new ArrayList<>();
    for (int i = 0; i < values.length; i += 2) {
      out.add(Map.of("value", values[i], "label", values[i + 1]));
    }
    return out;
  }

  private static Map<String,Object> params(Object... values) {
    Map<String,Object> out = new LinkedHashMap<>();
    for (int i = 0; i < values.length; i += 2) out.put(String.valueOf(values[i]), values[i + 1]);
    return out;
  }

  private static int clamp(Integer value, int min, int max) {
    int result = value == null ? min : value;
    return Math.max(min, Math.min(max, result));
  }

  private static Integer integer(Object value) {
    if (value instanceof Number n) return n.intValue();
    try {
      return Integer.valueOf(String.valueOf(value));
    } catch (NumberFormatException e) {
      return null;
    }
  }

  private static int integerOr(Object value, int fallback) {
    Integer parsed = integer(value);
    return parsed == null ? fallback : parsed;
  }

  private static BigDecimal decimal(Object value) {
    if (value instanceof BigDecimal decimal) return decimal;
    if (value instanceof Number n) return new BigDecimal(n.toString());
    try {
      return new BigDecimal(String.valueOf(value));
    } catch (NumberFormatException e) {
      return null;
    }
  }

  private static String text(Object value) {
    return value == null ? "" : String.valueOf(value);
  }

  private static List<?> inValues(Object value) {
    if (value instanceof List<?> list) {
      if (list.isEmpty()) throw ApiException.bad("IN 过滤条件至少需要一个值");
      return list;
    }
    List<String> values = java.util.Arrays.stream(String.valueOf(value).split(","))
        .map(String::trim)
        .filter(item -> !item.isEmpty())
        .toList();
    if (values.isEmpty()) throw ApiException.bad("IN 过滤条件至少需要一个值");
    return values;
  }

  private static String text(Object value, String fallback) {
    String text = text(value);
    return text.isEmpty() ? fallback : text;
  }
}
