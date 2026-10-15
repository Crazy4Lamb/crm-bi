package com.crazy4lamb.crmbi.service;

import com.crazy4lamb.crmbi.core.ApiException;
import com.crazy4lamb.crmbi.core.Db;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

/**
 * 指标计算（T+1）。
 *
 * <p>两类指标：
 * <ul>
 *   <li><b>内置指标</b>（{@code code} 命中下方 switch）：为高频经营指标手写 SQL，性能最好；</li>
 *   <li><b>自定义指标</b>：完全由用户在指标设计页配置 —— 走
 *       {@link #computeConfigured}，从 rpt_report / rpt_dataset 元数据推导 SQL。</li>
 * </ul>
 */
@Service
public class MetricService {
  private final Db db;

  public MetricService(Db db) {
    this.db = db;
  }

  /** 按 statDate 计算指标值，不落库。 */
  public BigDecimal compute(Map<String,Object> metric, LocalDate date) {
    String code = String.valueOf(metric.get("code"));
    String sql = switch (code) {
      case "m_sales_amount_day" ->
          "select coalesce(sum(amount),0) value from crm_contract where sign_date = :date";
      case "m_sales_mtd" ->
          "select coalesce(sum(amount),0) value from crm_contract"
              + " where sign_date between date_trunc('month', cast(:date as date))::date and :date";
      case "m_contract_cnt_day" ->
          "select count(*)::numeric value from crm_contract where sign_date = :date";
      case "m_order_amount_day" ->
          "select coalesce(sum(amount),0) value from crm_order"
              + " where order_date = :date and status <> 'refund'";
      case "m_order_cnt_day" ->
          "select count(*)::numeric value from crm_order"
              + " where order_date = :date and status <> 'refund'";
      case "m_avg_order_amount_day" ->
          "select coalesce(avg(amount),0) value from crm_order"
              + " where order_date = :date and status <> 'refund'";
      case "m_active_customer_day" ->
          "select count(distinct customer_id)::numeric value from crm_order"
              + " where order_date = :date and status <> 'refund'";
      case "m_new_customer_day" ->
          "select count(*)::numeric value from crm_customer where created_at::date = :date";
      case "m_new_lead_day" ->
          "select count(*)::numeric value from crm_lead where created_at::date = :date";
      case "m_lead_convert_day" ->
          "select count(*) filter(where customer_id is not null)::numeric value"
              + " from crm_lead where created_at::date = :date";
      case "m_lead_convert_rate_day" ->
          "select coalesce(count(*) filter(where customer_id is not null)::numeric"
              + " / nullif(count(*),0), 0) value from crm_lead where created_at::date = :date";
      case "m_gross_margin_day" ->
          "select coalesce((sum(amount) - sum(cost)) / nullif(sum(amount),0), 0) value"
              + " from crm_contract where sign_date = :date";
      default -> null;
    };
    if (sql == null) return computeConfigured(metric, date);

    Object value = db.one(sql, Map.of("date", date)).get("value");
    return decimal(value);
  }

  /**
   * 自定义指标：把「报表 → 数据集 → 字段表达式」翻译成一条参数化聚合 SQL。
   *
   * <p>安全约束：表名/别名/字段表达式全部来自 rpt_dataset* 元数据表，
   * 且都经过 {@link #identifier} 或字符集白名单校验；取值一律走具名参数。
   */
  private BigDecimal computeConfigured(Map<String,Object> metric, LocalDate date) {
    Map<String,Object> source = db.one("""
        select d.id dataset_id, d.base_table, d.base_alias, d.joins
        from rpt_report r
        join rpt_dataset d on d.id = r.dataset_id
        where r.id = :id""",
        Map.of("id", metric.get("report_id")));
    if (source == null) throw ApiException.bad("指标的数据来源报表不存在");

    String table = identifier(source.get("base_table"));
    String alias = identifier(source.getOrDefault("base_alias", "t"));

    // 报表字段 → 数据集字段表达式的映射
    List<Map<String,Object>> fields = db.many("""
        select rf.field_key, df.expr
        from rpt_report_field rf
        join rpt_dataset_field df
          on df.dataset_id = :dataset and df.field_key = rf.dataset_field_key
        where rf.report_id = :report""",
        Map.of("dataset", source.get("dataset_id"), "report", metric.get("report_id")));
    Map<String,String> expressions = new LinkedHashMap<>();
    fields.forEach(field -> expressions.put(
        String.valueOf(field.get("field_key")), String.valueOf(field.get("expr"))));

    String measure = expressions.get(String.valueOf(metric.get("measure_key")));
    String dateExpr = expressions.get(String.valueOf(metric.get("date_field_key")));
    if (measure == null || dateExpr == null) throw ApiException.bad("指标字段没有映射到数据集白名单");

    String agg = String.valueOf(metric.getOrDefault("agg_fn", "sum"));
    String valueExpr = switch (agg) {
      case "sum", "avg", "max", "min" -> agg + "(" + measure + ")";
      case "count" -> "count(" + measure + ")";
      case "count_distinct" -> "count(distinct " + measure + ")";
      default -> throw ApiException.bad("不支持的统计方式：" + agg);
    };

    // FROM 子句（含数据集配置的 JOIN）
    StringBuilder from = new StringBuilder(" from ").append(table).append(' ').append(alias);
    Object joins = source.get("joins");
    if (joins instanceof List<?> list) {
      for (Object item : list) {
        if (!(item instanceof Map<?,?> join)) continue;
        String type = "inner".equalsIgnoreCase(String.valueOf(join.get("type")))
            ? " inner join "
            : " left join ";
        String joinTable = identifier(join.get("table"));
        String joinAlias = identifier(join.get("alias"));
        String on = String.valueOf(join.get("on"));
        if (!on.matches("[A-Za-z0-9_ .='()]+")) throw ApiException.bad("数据集关联表达式无效");
        from.append(type).append(joinTable).append(' ').append(joinAlias).append(" on ").append(on);
      }
    }

    // WHERE：日期口径 + 用户配置的过滤条件
    Map<String,Object> params = new LinkedHashMap<>();
    params.put("date", date);

    String mode = String.valueOf(metric.getOrDefault("date_mode", "day"));
    String day = "cast(:date as date)";
    String dateWhere = switch (mode) {
      case "mtd" -> dateExpr + "::date between date_trunc('month', " + day + ")::date and " + day;
      case "month" -> dateExpr + "::date >= date_trunc('month', " + day + ")::date and "
          + dateExpr + "::date < (date_trunc('month', " + day + ") + interval '1 month')::date";
      case "last7" -> dateExpr + "::date between " + day + " - 6 and " + day;
      case "last30" -> dateExpr + "::date between " + day + " - 29 and " + day;
      case "all" -> "true";
      default -> dateExpr + "::date = " + day;
    };

    StringBuilder where = new StringBuilder(" where ").append(dateWhere);

    Object filters = metric.get("filters");
    int seq = 0;
    if (filters instanceof List<?> list) {
      for (Object item : list) {
        if (!(item instanceof Map<?,?> filter)) continue;
        String expr = expressions.get(String.valueOf(filter.get("fieldKey")));
        if (expr == null) throw ApiException.bad("指标过滤字段不存在");

        String op = String.valueOf(filter.get("op"));
        if ("isnull".equals(op) || "notnull".equals(op)) {
          where.append(" and ").append(expr)
              .append("notnull".equals(op) ? " is not null" : " is null");
          continue;
        }

        String param = "f" + (seq++);
        params.put(param, filter.get("value"));
        String sqlOp = switch (op) {
          case "eq" -> "=";
          case "ne" -> "<>";
          case "gt" -> ">";
          case "ge" -> ">=";
          case "lt" -> "<";
          case "le" -> "<=";
          case "like" -> "ilike";
          default -> throw ApiException.bad("指标过滤操作符无效");
        };
        where.append(" and ").append(expr).append(' ').append(sqlOp).append(" :").append(param);
        if ("like".equals(op)) params.put(param, "%" + filter.get("value") + "%");
      }
    }

    Object value = db.one(
        "select coalesce(" + valueExpr + ", 0) value" + from + where, params).get("value");
    return decimal(value);
  }

  /** 标识符白名单：只允许字母、数字、下划线，且不以数字开头。 */
  private static String identifier(Object value) {
    String text = String.valueOf(value);
    if (!text.matches("[A-Za-z_][A-Za-z0-9_]*")) throw ApiException.bad("数据集标识无效");
    return text;
  }

  /**
   * 计算并落库（幂等，按 metric_id + stat_date 覆盖写），
   * 同时把上一期的值写进 prev_value，供卡片算真实环比。
   */
  public BigDecimal persist(Map<String,Object> metric, LocalDate date, Number taskLogId) {
    BigDecimal value = compute(metric, date);
    Map<String,Object> previous = db.one("""
        select value from bi_metric_value
        where metric_id = :id and stat_date < :date
        order by stat_date desc limit 1""",
        Map.of("id", metric.get("id"), "date", date));

    Map<String,Object> params = new LinkedHashMap<>();
    params.put("id", metric.get("id"));
    params.put("date", date);
    params.put("value", value);
    params.put("previous", previous == null ? null : previous.get("value"));
    params.put("log", taskLogId);

    db.update("""
        insert into bi_metric_value(metric_id, stat_date, value, prev_value, task_log_id)
        values(:id, :date, :value, :previous, :log)
        on conflict(metric_id, stat_date) do update set
          value = excluded.value,
          prev_value = excluded.prev_value,
          calc_time = now(),
          task_log_id = excluded.task_log_id""",
        params);
    return value;
  }

  private static BigDecimal decimal(Object value) {
    return value instanceof BigDecimal number ? number : new BigDecimal(String.valueOf(value));
  }
}
