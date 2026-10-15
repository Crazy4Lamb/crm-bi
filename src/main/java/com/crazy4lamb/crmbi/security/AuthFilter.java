package com.crazy4lamb.crmbi.security;

import com.crazy4lamb.crmbi.core.Db;
import com.crazy4lamb.crmbi.core.UserPrincipal;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * 令牌鉴权过滤器：解析 Bearer JWT → 回查 sys_user（保证被禁用/删除的账号立即失效）→ 写入请求属性。
 */
@Component
public class AuthFilter extends OncePerRequestFilter {
  /** 登录用户放入 request 属性的键，AuthController.user() 读取它。 */
  public static final String USER = "crm.user";

  private final JwtService jwt;
  private final Db db;

  public AuthFilter(JwtService jwt, Db db) {
    this.jwt = jwt;
    this.db = db;
  }

  @Override
  protected boolean shouldNotFilter(HttpServletRequest request) {
    String path = request.getRequestURI();
    return !path.startsWith("/api/")
        || path.equals("/api/health")
        || path.equals("/api/auth/login")
        || path.equals("/api/auth/demo-accounts");
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    String header = request.getHeader("Authorization");
    String token = header != null && header.startsWith("Bearer ")
        ? header.substring(7)
        : null;
    try {
      if (token == null || token.isBlank()) throw new IllegalArgumentException("缺少令牌");
      Map<String,Object> claims = jwt.verify(token);
      Map<String,Object> row = db.one("""
          select id, username, real_name, role_code, dept, data_scope, status
          from sys_user
          where id = :id""",
          Map.of("id", ((Number) claims.get("uid")).intValue()));
      if (row == null || !"1".equals(String.valueOf(row.get("status")))) {
        throw new IllegalArgumentException("账号已失效");
      }

      UserPrincipal user = new UserPrincipal(
          ((Number) row.get("id")).intValue(),
          String.valueOf(row.get("username")),
          String.valueOf(row.get("real_name")),
          String.valueOf(row.get("role_code")),
          (String) row.get("dept"),
          String.valueOf(row.get("data_scope")));

      request.setAttribute(USER, user);
      SecurityContextHolder.getContext()
          .setAuthentication(new UsernamePasswordAuthenticationToken(user, token, List.of()));
      chain.doFilter(request, response);
    } catch (Exception error) {
      response.setStatus(401);
      response.setContentType(MediaType.APPLICATION_JSON_VALUE);
      response.setCharacterEncoding("UTF-8");
      response.getWriter().write("{\"code\":401,\"message\":\"未登录或登录已过期\"}");
    }
  }
}
