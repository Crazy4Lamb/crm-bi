package com.crazy4lamb.crmbi.service;

import com.crazy4lamb.crmbi.core.ApiException;
import com.crazy4lamb.crmbi.core.Db;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.stereotype.Service;

/**
 * 元数据驱动的通用查询引擎。
 *
 * <p>把 {@code rpt_dataset} + {@code rpt_dataset_field} + {@code rpt_report_field} 三张元数据表描述的
 * 取数需求翻译成一条参数化 SQL，让报表执行与统计图渲染共用同一套实现，不再依赖按 ID 硬编码的 SQL。
 *
 * <p><b>字段解析的两层结构</b>：
 * <ul>
 *   <li>{@link Expressions#raw()} —— 字段的原始 SQL 片段，用于 SELECT 维度列、WHERE 过滤与明细查询；</li>
 *   <li>{@link Expressions#aggregated()} —— 字段按自身 {@code agg_fn} 聚合后的完整表达式，
 *       用于分组查询的度量列，以及自定义公式里的字段引用。</li>
 * </ul>
 *
 * <p>自定义公式（{@code custom_expr}）中的字段引用支持两种写法：{@code {key}} 显式花括号，
 * 以及裸标识符直接写字段名（如 {@code amount / nullif(contract_cnt, 0)}）。
 * 字符串字面量（{@code '...'}）内的内容不会被替换。
 *
 * <p>安全约定：
 * <ul>
 *   <li>表名、别名、字段键一律经 {@link #identifier} 白名单校验；</li>
 *   <li>字段表达式只允许字母数字、下划线、常见运算符与单引号（可含中文表意文字用于表内文案），
 *       并显式拒绝 {@code --}、{@code ;}、{@code /*}、{@code *}{@code /}；</li>
 *   <li>join 的 on 表达式只允许字母数字、下划线、空格与 {@code . = ' ( )}；</li>
 *   <li>聚合函数与比较操作符一律走 switch 白名单；</li>
 *   <li>所有取值走具名参数绑定，不做字符串拼接值。</li>
 * </ul>
 */
@Service
public class QueryEngine {

  /** 允许出现在字段表达式中的字符集（含中文，便于写表内文案）。 */
  private static final String EXPR_PATTERN =
      "[A-Za-z0-9_ .()+\\-*/%<>=,:'\\u3000-\\u303f\\u4e00-\\u9fff\\uff00-\\uffef]+";

  /** 排序方向白名单。 */
  private static final Set<String> SORT_DIRECTIONS = Set.of("asc", "desc");

  private final Db db;

  public QueryEngine(Db db) {
    this.db = db;
  }

  // ------------------------------------------------------------------ 模型

  /** 数据集及其字段元数据。 */
  public record Dataset(int id, String code, String name, String baseTable, String baseAlias,
                        List<Join> joins, String dateField, String ownerField, String deptField) {}

  /** 数据集关联。 */
  public record Join(String type, String table, String alias, String on) {}

  /** 报表字段设计。 */
  public record Field(String key, String name, String type, String role, String agg,
                      boolean custom, String customExpr, String datasetKey, boolean groupBy) {

    /** 是否为「原值」聚合（表达式已自带聚合语义，不再外套函数）。 */
    public boolean raw() {
      return agg == null || agg.isBlank() || "none".equalsIgnoreCase(agg);
    }

    /** 是否为纯计数（无数据集字段映射，直接 count(*)。 */
    public boolean counter() {
      return "count".equalsIgnoreCase(agg);
    }
  }

  /** 一个度量系列：取哪个字段、用什么统计方式、是否按某维度拆分（堆叠）。 */
  public record Series(String key, String agg, String name, String splitBy) {}

  /** 过滤条件。 */
  public record Filter(String fieldKey, String op, Object value, Object value2) {}

  /** 一次查询的完整描述。 */
  public record Request(int datasetId, List<String> dims, List<Series> series, List<Filter> filters,
                        String sortStrategy, String orderByKey, String orderDir, int limit,
                        boolean withTotal) {}

  /** 查询结果：行、列定义、小计、实际 SQL 与总行数。 */
  public record Result(List<Map<String,Object>> rows, List<Map<String,Object>> columns,
                       Map<String,Object> total, String sql, long totalRows) {}

  /** 字段表达式的两种形态，外加字段类型（用于给参数做类型转换）。 */
  public record Expressions(Map<String,String> raw, Map<String,String> aggregated,
                            Map<String,String> types) {

    public String rawOf(String key) {
      return raw.get(key);
    }

    public String measureOf(String key) {
      return aggregated.get(key);
    }

    /** 该字段是否日期型；日期字段与字符串参数比较时需要显式 cast，否则 PG 报类型不匹配。 */
    public boolean isDate(String key) {
      String type = types.get(key);
      return type != null && (type.startsWith("date") || type.startsWith("datetime")
          || type.startsWith("timestamp"));
    }
  }

  // ------------------------------------------------------------------ 元数据加载

  /** 按数据集 id 加载数据集。 */
  public Dataset dataset(int datasetId) {
    return toDataset(db.one(
        "select id,code,name,base_table,base_alias,joins,date_field,owner_field,dept_field"
            + " from rpt_dataset where id=:id and status='1'",
        Map.of("id", datasetId)));
  }

  /** 按报表 id 加载其所属数据集。 */
  public Dataset datasetOfReport(int reportId) {
    Map<String,Object> row = db.one(
        "select d.id,d.code,d.name,d.base_table,d.base_alias,d.joins,d.date_field,d.owner_field,"
            + "d.dept_field from rpt_report r join rpt_dataset d on d.id=r.dataset_id where r.id=:id",
        Map.of("id", reportId));
    if (row == null) throw ApiException.notFound("报表不存在");
    return toDataset(row);
  }

  private Dataset toDataset(Map<String,Object> row) {
    if (row == null) throw ApiException.bad("数据集不存在");
    List<Join> joins = new ArrayList<>();
    if (row.get("joins") instanceof List<?> list) {
      for (Object item : list) {
        if (item instanceof Map<?,?> join) {
          joins.add(new Join(
              text(join.get("type"), "left"),
              identifier(join.get("table")),
              identifier(join.get("alias")),
              joinOn(join.get("on"))));
        }
      }
    }
    return new Dataset(
        number(row.get("id")), text(row.get("code"), null), text(row.get("name"), null),
        identifier(row.get("base_table")), identifier(row.getOrDefault("base_alias", "t")),
        List.copyOf(joins), text(row.get("date_field"), null),
        text(row.get("owner_field"), null), text(row.get("dept_field"), null));
  }

  /** 报表字段设计列表，按 sort_no 排序。 */
  public List<Field> reportFields(int reportId) {
    return db.many("""
        select field_key, field_name, field_type, field_role, agg_fn,
               is_custom, custom_expr, dataset_field_key, is_group_by
        from rpt_report_field
        where report_id=:id and coalesce(is_show, true)
        order by sort_no, id""",
        Map.of("id", reportId)).stream()
        .map(row -> new Field(
            text(row.get("field_key"), null), text(row.get("field_name"), null),
            text(row.get("field_type"), "string"), text(row.get("field_role"), "dimension"),
            text(row.get("agg_fn"), "none"),
            Boolean.TRUE.equals(row.get("is_custom")), text(row.get("custom_expr"), null),
            text(row.get("dataset_field_key"), null),
            Boolean.TRUE.equals(row.get("is_group_by"))))
        .toList();
  }

  /** 数据集字段（维度/度量定义），按 sort_no 排序。 */
  public List<Field> datasetFields(int datasetId) {
    return db.many("""
        select field_key, field_name, field_type, field_role
        from rpt_dataset_field
        where dataset_id=:id
        order by sort_no, id""",
        Map.of("id", datasetId)).stream()
        .map(row -> new Field(
            text(row.get("field_key"), null), text(row.get("field_name"), null),
            text(row.get("field_type"), "string"), text(row.get("field_role"), "dimension"),
            "none", false, null, null, false))
        .toList();
  }

  // ------------------------------------------------------------------ 字段表达式解析

  /**
   * 解析一组字段的 SQL 表达式。
   *
   * <p>普通字段按 {@code dataset_field_key}（缺省用 {@code field_key}）到数据集里找 {@code expr}；
   * 没有映射但统计方式是 {@code count} 的字段视为「行数」，映射成 {@code *}。
   *
   * <p>自定义字段按 {@code custom_expr} 展开字段引用：{@code agg_fn=none} 时引用的是其它字段的
   * <b>聚合后</b>表达式（因为整个式子本身就是一个度量），否则引用原始表达式再外套聚合函数。
   * 最多展开 4 轮，兼顾字段间互相引用并避免循环引用。
   */
  public Expressions expressions(Dataset dataset, List<Field> fields) {
    Map<String,String> datasetExprs = new LinkedHashMap<>();
    Map<String,String> datasetTypes = new LinkedHashMap<>();
    for (Map<String,Object> row : db.many(
        "select field_key, field_type, expr from rpt_dataset_field where dataset_id=:id",
        Map.of("id", dataset.id()))) {
      String key = text(row.get("field_key"), "");
      datasetExprs.put(key, expression(row.get("expr")));
      datasetTypes.put(key, text(row.get("field_type"), "string"));
    }

    // 第一层：原始表达式
    Map<String,String> raw = new LinkedHashMap<>();
    Map<String,String> types = new LinkedHashMap<>();
    for (Field field : fields) {
      if (field.custom()) continue;
      String datasetKey = notBlank(field.datasetKey()) ? field.datasetKey() : field.key();
      String expr = datasetExprs.get(datasetKey);
      if (expr == null && field.counter()) {
        expr = "*";
        datasetTypes.put(datasetKey, "number");
      }
      if (expr == null) continue;
      raw.put(field.key(), expr);
      types.put(field.key(), datasetTypes.getOrDefault(datasetKey, "string"));
    }

    // 第二层：按各自 agg_fn 聚合后的表达式
    Map<String,String> aggregated = new LinkedHashMap<>();
    for (Field field : fields) {
      String expr = raw.get(field.key());
      if (expr == null) continue;
      aggregated.put(field.key(), field.raw() ? expr : aggregate(field.agg(), expr));
    }

    // 自定义字段逐轮展开
    for (int round = 0; round < 4; round++) {
      boolean changed = false;
      for (Field field : fields) {
        if (!field.custom() || aggregated.containsKey(field.key())) continue;
        if (!notBlank(field.customExpr())) continue;
        // agg=none：公式整体即度量，引用别人的聚合结果；否则引用原始值再外套聚合
        String expanded = expand(field.customExpr(), raw, aggregated, field.raw());
        if (expanded == null) continue;
        String sql = field.raw() ? expanded : aggregate(field.agg(), expanded);
        try {
          aggregated.put(field.key(), expression(sql));
          raw.put(field.key(), expanded);
          changed = true;
        } catch (ApiException invalid) {
          // 表达式不合法就留给 require() 报错，不影响其它字段
        }
      }
      if (!changed) break;
    }
    return new Expressions(Map.copyOf(raw), Map.copyOf(aggregated), Map.copyOf(types));
  }

  /**
   * 把自定义公式里的字段引用替换为对应 SQL 片段。
   *
   * <p>支持 {@code {key}} 与裸标识符两种写法；单引号字符串字面量内的内容原样保留。
   *
   * @param aggregated true 时引用字段的聚合表达式，false 时引用原始表达式
   * @return 任一引用无法解析时返回 null
   */
  private String expand(String template, Map<String,String> raw,
                        Map<String,String> aggregated, boolean aggregatedRefs) {
    StringBuilder out = new StringBuilder();
    int i = 0;
    while (i < template.length()) {
      char c = template.charAt(i);

      if (c == '\'') {
        int end = template.indexOf('\'', i + 1);
        if (end < 0) return null;
        out.append(template, i, end + 1);
        i = end + 1;
        continue;
      }

      if (c == '{') {
        int end = template.indexOf('}', i);
        if (end < 0) return null;
        String sql = substitute(template.substring(i + 1, end), raw, aggregated, aggregatedRefs);
        if (sql == null) return null;
        out.append(sql);
        i = end + 1;
        continue;
      }

      if (Character.isLetter(c) || c == '_') {
        int j = i;
        while (j < template.length()
            && (Character.isLetterOrDigit(template.charAt(j)) || template.charAt(j) == '_')) {
          j++;
        }
        String token = template.substring(i, j);
        String sql = substitute(token, raw, aggregated, aggregatedRefs);
        out.append(sql == null ? token : sql);
        i = j;
        continue;
      }

      out.append(c);
      i++;
    }
    return out.toString();
  }

  private String substitute(String key, Map<String,String> raw,
                            Map<String,String> aggregated, boolean aggregatedRefs) {
    if (!raw.containsKey(key)) return null;
    return aggregatedRefs ? aggregated.getOrDefault(key, raw.get(key)) : raw.get(key);
  }

  // ------------------------------------------------------------------ 取数

  /** 按数据集执行聚合查询。 */
  public Result query(Request request) {
    Dataset dataset = dataset(request.datasetId());
    Set<String> referenced = referencedKeys(request);
    List<Field> fields = datasetFields(dataset.id()).stream()
        .filter(field -> referenced.contains(field.key()))
        .toList();
    return run(dataset, expressions(dataset, fields), fields, request);
  }

  /** 按报表执行查询（走报表字段设计，含自定义字段）。 */
  public Result queryReport(int reportId, Request request) {
    Dataset dataset = datasetOfReport(reportId);
    List<Field> fields = reportFields(reportId);
    return run(dataset, expressions(dataset, fields), fields, request);
  }

  private Set<String> referencedKeys(Request request) {
    Set<String> referenced = new LinkedHashSet<>(request.dims());
    for (Series series : request.series()) {
      referenced.add(series.key());
      if (notBlank(series.splitBy())) referenced.add(series.splitBy());
    }
    request.filters().forEach(filter -> referenced.add(filter.fieldKey()));
    if (notBlank(request.orderByKey())) referenced.add(request.orderByKey());
    return referenced;
  }

  private Result run(Dataset dataset, Expressions exprs, List<Field> fields, Request request) {
    Map<String,String> labels = new LinkedHashMap<>();
    for (Field field : fields) {
      labels.put(field.key(), notBlank(field.name()) ? field.name() : field.key());
    }

    List<String> selects = new ArrayList<>();
    List<Map<String,Object>> columns = new ArrayList<>();
    List<String> groupBy = new ArrayList<>();

    // 1. 维度列
    for (String key : request.dims()) {
      String column = identifier(key);
      String expr = require(exprs.rawOf(key), "维度");
      selects.add(expr + " as " + column);
      groupBy.add(expr);
      columns.add(Map.of("key", column, "name", labels.getOrDefault(key, key), "role", "dimension"));
    }

    // 2. 拆分维度列（堆叠系列共用同一批）
    List<String> splitKeys = new ArrayList<>();
    for (Series series : request.series()) {
      if (notBlank(series.splitBy()) && !splitKeys.contains(series.splitBy())) {
        splitKeys.add(series.splitBy());
      }
    }
    for (String key : splitKeys) {
      String column = identifier(key) + "_split";
      String expr = require(exprs.rawOf(key), "拆分维度");
      selects.add(expr + " as " + column);
      groupBy.add(expr);
      columns.add(Map.of("key", column, "name", labels.getOrDefault(key, key), "role", "split"));
    }

    // 3. 度量列：agg=none 直接用聚合表达式，否则按系列的统计方式外套一层
    List<String> valueColumns = new ArrayList<>();
    Set<String> used = new LinkedHashSet<>();
    for (String key : request.dims()) used.add(identifier(key));
    used.addAll(splitKeys);
    for (Series series : request.series()) {
      // 只有列名真的撞车时才加序号后缀，避免把 amount 变成 amount_1
      String base = identifier(series.key());
      String column = base;
      for (int suffix = 2; !used.add(column); suffix++) column = base + "_" + suffix;

      selects.add(measure(exprs, series) + " as " + column);
      valueColumns.add(column);
      String label = notBlank(series.name()) ? series.name() : labels.getOrDefault(series.key(), series.key());
      columns.add(Map.of("key", column, "name", label, "role", "measure"));
    }

    if (selects.isEmpty()) throw ApiException.bad("请至少选择一个维度或度量");

    // 4. FROM / JOIN
    StringBuilder sql = new StringBuilder("select ").append(String.join(", ", selects));
    sql.append(" from ").append(dataset.baseTable()).append(' ').append(dataset.baseAlias());
    for (Join join : dataset.joins()) {
      sql.append("inner".equalsIgnoreCase(join.type()) ? " inner join " : " left join ")
         .append(join.table()).append(' ').append(join.alias()).append(" on ").append(join.on());
    }

    // 5. WHERE：全部走具名参数；日期字段的字符串参数需显式 cast，否则 PG 类型不匹配
    Map<String,Object> params = new LinkedHashMap<>();
    StringBuilder where = new StringBuilder(" where true");
    int n = 0;
    for (Filter filter : request.filters()) {
      if (filter == null || !notBlank(filter.fieldKey())) continue;
      String key = filter.fieldKey();
      String expr = require(exprs.rawOf(key), "过滤");
      boolean dateField = exprs.isDate(key);
      String op = text(filter.op(), "eq").toLowerCase();
      if ("isnull".equals(op)) { where.append(" and ").append(expr).append(" is null"); continue; }
      if ("notnull".equals(op)) { where.append(" and ").append(expr).append(" is not null"); continue; }
      if ("between".equals(op)) {
        String low = "lo" + n;
        String high = "hi" + n;
        params.put(low, filter.value());
        params.put(high, filter.value2());
        where.append(" and ").append(expr)
            .append(dateField ? " between cast(:" + low + " as date) and cast(:" + high + " as date)"
                              : " between :" + low + " and :" + high);
        n++;
        continue;
      }
      String name = "f" + n++;
      String sqlOp = comparison(op);
      if ("like".equals(op)) {
        params.put(name, "%" + filter.value() + "%");
      } else if ("in".equals(op)) {
        params.put(name, arrayValue(filter.value()));
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
    sql.append(where);

    // 6. GROUP BY：有维度且有度量时按维度聚合
    if (!groupBy.isEmpty() && !request.series().isEmpty()) {
      sql.append(" group by ").append(String.join(", ", groupBy));
    }

    // 7. ORDER BY / LIMIT
    sql.append(orderBy(request, valueColumns, columns));
    if (request.limit() > 0) {
      params.put("limit", request.limit());
      sql.append(" limit :limit");
    }

    List<Map<String,Object>> rows = db.many(sql.toString(), params);

    // 8. 小计：分组模式下对度量列求和
    Map<String,Object> total = new LinkedHashMap<>();
    if (!request.dims().isEmpty() && request.withTotal()) {
      for (String column : valueColumns) {
        total.put(column, rows.stream()
            .map(row -> row.get(column))
            .filter(Number.class::isInstance)
            .mapToDouble(value -> ((Number) value).doubleValue())
            .sum());
      }
    }

    return new Result(rows, List.copyOf(columns), total, sql.toString(), rows.size());
  }

  /** 系列的度量表达式：agg=none 用字段自带的聚合式，否则按系列统计方式外套一层。 */
  private String measure(Expressions exprs, Series series) {
    String agg = series.agg();
    if (agg == null || agg.isBlank() || "none".equalsIgnoreCase(agg)) {
      return require(exprs.measureOf(series.key()), "度量");
    }
    return aggregate(agg, require(exprs.rawOf(series.key()), "度量"));
  }

  /** 排序：优先用户指定字段，其次排序策略。 */
  private String orderBy(Request request, List<String> valueColumns, List<Map<String,Object>> columns) {
    if (notBlank(request.orderByKey())) {
      String key = identifier(request.orderByKey());
      boolean allowed = columns.stream().anyMatch(column -> key.equals(column.get("key")));
      if (allowed) {
        String dir = SORT_DIRECTIONS.contains(text(request.orderDir(), "desc").toLowerCase())
            ? text(request.orderDir(), "desc").toLowerCase()
            : "desc";
        return " order by " + key + " " + dir + " nulls last";
      }
    }
    if (!valueColumns.isEmpty()) {
      String valueColumn = valueColumns.getFirst();
      if ("value_desc".equals(request.sortStrategy())) {
        return " order by " + valueColumn + " desc nulls last";
      }
      if ("value_asc".equals(request.sortStrategy())) {
        return " order by " + valueColumn + " asc nulls last";
      }
    }
    if ("axis".equals(request.sortStrategy()) && !request.dims().isEmpty()) return " order by 1 asc";
    return "";
  }

  // ------------------------------------------------------------------ 白名单

  /** 表名/别名/字段键：只允许字母、数字、下划线，且不以数字开头。 */
  public static String identifier(Object value) {
    String text = String.valueOf(value == null ? "" : value).trim();
    if (!text.matches("[A-Za-z_][A-Za-z0-9_]*")) throw ApiException.bad("标识符无效：" + text);
    return text;
  }

  /** SQL 表达式：字符集白名单（含中文表意文字），并拒绝注释与语句终止符。 */
  static String expression(Object value) {
    String text = String.valueOf(value == null ? "" : value).trim();
    if (text.isEmpty() || !text.matches(EXPR_PATTERN)
        || text.contains("--") || text.contains(";")
        || text.contains("/*") || text.contains("*/")) {
      throw ApiException.bad("字段表达式无效");
    }
    return text;
  }

  /** join 的 on 表达式：更严，不允许算术与比较运算符。 */
  private static String joinOn(Object value) {
    String text = String.valueOf(value == null ? "" : value).trim();
    if (text.isEmpty() || !text.matches("[A-Za-z0-9_ .='()]+")) {
      throw ApiException.bad("数据集关联表达式无效");
    }
    return text;
  }

  /** 聚合函数白名单，返回「函数(表达式)」片段。 */
  static String aggregate(String agg, String expr) {
    return switch (text(agg, "sum").toLowerCase()) {
      case "sum", "avg", "max", "min" -> text(agg, "sum").toLowerCase() + "(" + expr + ")";
      case "count" -> "count(" + expr + ")";
      case "count_distinct" -> "count(distinct " + expr + ")";
      case "none", "" -> expr;
      default -> throw ApiException.bad("不支持的统计方式：" + agg);
    };
  }

  /** 比较操作符白名单。 */
  public static String comparison(String op) {
    return switch (text(op, "eq").toLowerCase()) {
      case "eq", "=" -> "=";
      case "ne", "!=", "<>" -> "<>";
      case "gt", ">" -> ">";
      case "ge", ">=" -> ">=";
      case "lt", "<" -> "<";
      case "le", "<=" -> "<=";
      case "like" -> "ilike";
      case "in" -> "in";
      default -> throw ApiException.bad("不支持的过滤操作符：" + op);
    };
  }

  private static String require(String expr, String kind) {
    if (expr == null) throw ApiException.bad(kind + "字段不存在或未映射");
    return expr;
  }

  /**
   * 解析过滤值里的相对日期变量：{@code $D30} → 30 天前、{@code $MONTH_START} → 本月 1 日、
   * {@code $TODAY} → 今天。不是变量的值原样返回。
   */
  public static Object resolveValue(Object value) {
    if (value == null) return null;
    String text = String.valueOf(value);
    LocalDate today = LocalDate.now();
    if (text.startsWith("$D") && text.length() > 2) {
      try {
        return today.minusDays(Long.parseLong(text.substring(2))).toString();
      } catch (NumberFormatException ignored) {
        return value;
      }
    }
    return switch (text) {
      case "$TODAY" -> today.toString();
      case "$YESTERDAY" -> today.minusDays(1).toString();
      case "$MONTH_START" -> today.withDayOfMonth(1).toString();
      case "$MONTH_END" -> today.withDayOfMonth(today.lengthOfMonth()).toString();
      default -> value;
    };
  }

  // ------------------------------------------------------------------ 工具

  private static boolean notBlank(String value) {
    return value != null && !value.isBlank();
  }

  private static String text(Object value, String fallback) {
    String text = value == null ? "" : String.valueOf(value);
    return text.isEmpty() ? fallback : text;
  }

  private static int number(Object value) {
    return value instanceof Number n ? n.intValue() : Integer.parseInt(String.valueOf(value));
  }

  /** {@code in} 的取值统一转成集合，交给 NamedParameterJdbcTemplate 展开占位符。 */
  private static Object arrayValue(Object value) {
    if (value instanceof Collection<?> collection) {
      if (collection.isEmpty()) throw ApiException.bad("IN 过滤条件至少需要一个值");
      return List.copyOf(collection);
    }
    String raw = String.valueOf(value);
    if (raw.contains(",")) {
      List<String> values = java.util.Arrays.stream(raw.split(","))
          .map(String::trim)
          .filter(part -> !part.isEmpty())
          .toList();
      if (values.isEmpty()) throw ApiException.bad("IN 过滤条件至少需要一个值");
      return values;
    }
    if (raw.isBlank()) throw ApiException.bad("IN 过滤条件至少需要一个值");
    return List.of(raw);
  }
}
