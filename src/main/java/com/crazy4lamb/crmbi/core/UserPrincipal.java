package com.crazy4lamb.crmbi.core;

public record UserPrincipal(int id, String username, String realName, String role, String dept, String dataScope) {
  public boolean admin() { return "admin".equals(role); }
}
