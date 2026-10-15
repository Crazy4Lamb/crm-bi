package com.crazy4lamb.crmbi.controller;

import static com.crazy4lamb.crmbi.core.Api.ok;

import com.crazy4lamb.crmbi.core.Db;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HealthController {
  private final Db db;
  private final String timezone;

  public HealthController(Db db, @Value("${app.timezone}") String timezone) {
    this.db = db;
    this.timezone = timezone;
  }

  @GetMapping("/api/health")
  public Map<String,Object> health() {
    Map<String,Object> row = db.one(
        "select current_database() db, (select count(*) from sys_user) users");

    Map<String,Object> data = new LinkedHashMap<>();
    data.put("status", "up");
    data.put("db", "PostgreSQL @ " + row.get("db"));
    data.put("mode", "pg");
    data.put("runtime", "Spring Boot 3.5.8 / Java 21");
    data.put("timezone", timezone);
    data.put("users", row.get("users"));
    data.put("time", Instant.now());
    return ok(data);
  }
}
