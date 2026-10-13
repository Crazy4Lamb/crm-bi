package com.crazy4lamb.crmbi.core;

import java.util.LinkedHashMap;
import java.util.Map;

public final class Api {
  private Api() {}
  public static Map<String,Object> ok(Object data) { return ok(data, null); }
  public static Map<String,Object> ok(Object data, String message) {
    Map<String,Object> out = new LinkedHashMap<>();
    out.put("code", 0);
    if (message != null) out.put("message", message);
    out.put("data", data);
    return out;
  }
  public static Map<String,Object> message(String message) { return ok(null, message); }
}
