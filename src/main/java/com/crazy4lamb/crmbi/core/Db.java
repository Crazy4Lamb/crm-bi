package com.crazy4lamb.crmbi.core;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.Array;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import org.postgresql.util.PGobject;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * JDBC 门面。
 *
 * <p>事务入口 {@link #tx} 会先把当前用户写进 PostgreSQL 会话变量
 * （crm.user_id / crm.data_scope / crm.dept / crm.role），再执行业务逻辑，
 * 从而让数据库侧的 Row-Level Security 策略按角色与部门自动过滤数据。
 *
 * <p>所有查询一律用具名参数绑定；表名、列名等无法参数化的部分由各 Service
 * 先过白名单校验（见 {@code QueryEngine} 与 {@code MetricService}）。
 */
@Component
public class Db {
  private final JdbcTemplate jdbc;
  private final NamedParameterJdbcTemplate named;
  private final TransactionTemplate transactions;
  private final ObjectMapper json;

  public Db(
      JdbcTemplate jdbc,
      NamedParameterJdbcTemplate named,
      TransactionTemplate transactions,
      ObjectMapper json) {
    this.jdbc = jdbc;
    this.named = named;
    this.transactions = transactions;
    this.json = json;
  }

  /** 在事务内执行一段逻辑；user 为 null 时按 system / all 权限执行。 */
  public <T> T tx(UserPrincipal user, Function<Db,T> work) {
    return transactions.execute(status -> {
      UserPrincipal actor = user == null
          ? new UserPrincipal(0, "system", "System", "system", null, "all")
          : user;
      jdbc.queryForMap("""
          select set_config('crm.user_id', ?, true),
                 set_config('crm.data_scope', ?, true),
                 set_config('crm.dept', ?, true),
                 set_config('crm.role', ?, true)""",
          String.valueOf(actor.id()),
          actor.dataScope(),
          actor.dept() == null ? "" : actor.dept(),
          actor.role());
      return work.apply(this);
    });
  }

  // ------------------------------------------------------------------ 查询

  public List<Map<String,Object>> many(String sql) {
    return normalize(named.queryForList(sql, Map.of()));
  }

  public List<Map<String,Object>> many(String sql, Map<String,?> params) {
    return normalize(named.queryForList(sql, params));
  }

  public Map<String,Object> one(String sql) {
    return one(sql, Map.of());
  }

  /** 取第一行，没有则返回 null。 */
  public Map<String,Object> one(String sql, Map<String,?> params) {
    List<Map<String,Object>> rows = many(sql, params);
    return rows.isEmpty() ? null : rows.getFirst();
  }

  // ------------------------------------------------------------------ 写入

  public int update(String sql, Map<String,?> params) {
    return named.update(sql, params);
  }

  /** 执行 INSERT 并返回自增主键。 */
  public Number insertId(String sql, Map<String,?> params) {
    Map<String,Object> row = one(sql + " returning id", params);
    return (Number) row.get("id");
  }

  public JdbcTemplate jdbc() {
    return jdbc;
  }

  // ------------------------------------------------------------------ 值归一

  /** 把驱动返回的 PGobject（jsonb）与 sql.Array 转成前端可用的 Java 对象。 */
  private List<Map<String,Object>> normalize(List<Map<String,Object>> rows) {
    List<Map<String,Object>> out = new ArrayList<>(rows.size());
    for (Map<String,Object> row : rows) {
      Map<String,Object> clean = new LinkedHashMap<>();
      row.forEach((key, value) -> clean.put(key, normalizeValue(value)));
      out.add(clean);
    }
    return out;
  }

  private Object normalizeValue(Object value) {
    try {
      if (value instanceof PGobject pg
          && ("json".equals(pg.getType()) || "jsonb".equals(pg.getType()))) {
        return json.readValue(pg.getValue(), Object.class);
      }
      if (value instanceof Array array) return List.of((Object[]) array.getArray());
    } catch (SQLException | java.io.IOException parseError) {
      // 归一失败就保留原始值，不影响整行返回
    }
    return value;
  }
}
