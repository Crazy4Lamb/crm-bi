package com.crazy4lamb.crmbi.core;

public class ApiException extends RuntimeException {
  private final int status;
  public ApiException(int status, String message) { super(message); this.status = status; }
  public int status() { return status; }
  public static ApiException bad(String message) { return new ApiException(400, message); }
  public static ApiException forbidden(String message) { return new ApiException(403, message); }
  public static ApiException notFound(String message) { return new ApiException(404, message); }
}
