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

@Component
public class Db {
  private final JdbcTemplate jdbc;
  private final NamedParameterJdbcTemplate named;
  private final TransactionTemplate transactions;
  private final ObjectMapper json;

  public Db(JdbcTemplate jdbc, NamedParameterJdbcTemplate named, TransactionTemplate transactions, ObjectMapper json) {
    this.jdbc = jdbc; this.named = named; this.transactions = transactions; this.json = json;
  }

  public <T> T tx(UserPrincipal user, Function<Db,T> work) {
    return transactions.execute(status -> {
      UserPrincipal actor = user == null ? new UserPrincipal(0,"system","System","system",null,"all") : user;
      jdbc.queryForMap("select set_config('crm.user_id',?,true),set_config('crm.data_scope',?,true),set_config('crm.dept',?,true),set_config('crm.role',?,true)",
          String.valueOf(actor.id()), actor.dataScope(), actor.dept() == null ? "" : actor.dept(), actor.role());
      return work.apply(this);
    });
  }

  public List<Map<String,Object>> many(String sql) { return normalize(named.queryForList(sql, Map.of())); }
  public List<Map<String,Object>> many(String sql, Map<String,?> params) { return normalize(named.queryForList(sql, params)); }
  public Map<String,Object> one(String sql) { return one(sql, Map.of()); }
  public Map<String,Object> one(String sql, Map<String,?> params) {
    List<Map<String,Object>> rows = many(sql, params);
    return rows.isEmpty() ? null : rows.getFirst();
  }
  public int update(String sql, Map<String,?> params) { return named.update(sql, params); }
  public Number insertId(String sql, Map<String,?> params) {
    Map<String,Object> row = one(sql + " returning id", params);
    return (Number) row.get("id");
  }
  public JdbcTemplate jdbc() { return jdbc; }

  private List<Map<String,Object>> normalize(List<Map<String,Object>> rows) {
    List<Map<String,Object>> out = new ArrayList<>(rows.size());
    for (Map<String,Object> row : rows) {
      Map<String,Object> clean = new LinkedHashMap<>();
      row.forEach((key,value) -> clean.put(key, normalizeValue(value)));
      out.add(clean);
    }
    return out;
  }
  private Object normalizeValue(Object value) {
    try {
      if (value instanceof PGobject pg && ("json".equals(pg.getType()) || "jsonb".equals(pg.getType())))
        return json.readValue(pg.getValue(), Object.class);
      if (value instanceof Array array) return List.of((Object[]) array.getArray());
    } catch (SQLException | java.io.IOException ignored) { }
    return value;
  }
}
