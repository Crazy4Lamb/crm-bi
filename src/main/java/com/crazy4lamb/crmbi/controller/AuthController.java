package com.crazy4lamb.crmbi.controller;

import static com.crazy4lamb.crmbi.core.Api.ok;

import com.crazy4lamb.crmbi.core.ApiException;
import com.crazy4lamb.crmbi.core.Db;
import com.crazy4lamb.crmbi.core.UserPrincipal;
import com.crazy4lamb.crmbi.security.AuthFilter;
import com.crazy4lamb.crmbi.security.JwtService;
import com.crazy4lamb.crmbi.service.AclService;
import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/auth")
public class AuthController {
  private final Db db; private final PasswordEncoder passwords; private final JwtService jwt; private final AclService acl;
  public AuthController(Db db, PasswordEncoder passwords, JwtService jwt, AclService acl) { this.db=db; this.passwords=passwords; this.jwt=jwt; this.acl=acl; }

  @PostMapping("/login") public Map<String,Object> login(@RequestBody Map<String,Object> body) {
    String username = String.valueOf(body.getOrDefault("username", "")).trim();
    String password = String.valueOf(body.getOrDefault("password", ""));
    if (username.isEmpty() || password.isEmpty()) throw ApiException.bad("请输入用户名和密码");
    Map<String,Object> row = db.one("select u.*,r.name role_name from sys_user u join sys_role r on r.code=u.role_code where username=:username", Map.of("username", username));
    if (row == null || !"1".equals(String.valueOf(row.get("status"))) || !passwords.matches(password, String.valueOf(row.get("password")))) throw ApiException.bad("用户名或密码错误");
    UserPrincipal user = principal(row);
    Object last = row.get("last_login_at");
    db.update("update sys_user set last_login_at=now() where id=:id", Map.of("id",user.id()));
    db.update("insert into sys_oper_log(user_id,username,action,res_type,res_key,detail) values(:id,:username,'login','auth',:role,'登录成功')", Map.of("id",user.id(),"username",user.username(),"role",user.role()));
    Map<String,Object> data = profile(user, String.valueOf(row.get("role_name")), last); data.put("token", jwt.sign(user));
    return ok(data, "ok");
  }

  @GetMapping("/me") public Map<String,Object> me(HttpServletRequest request) {
    UserPrincipal user = user(request);
    Map<String,Object> row = db.one("select u.*,r.name role_name from sys_user u join sys_role r on r.code=u.role_code where u.id=:id", Map.of("id",user.id()));
    return ok(profile(user, String.valueOf(row.get("role_name")), row.get("last_login_at")));
  }
  @GetMapping("/menus") public Map<String,Object> menus(HttpServletRequest request) { return ok(acl.menus(user(request).role())); }
  @GetMapping("/demo-accounts") public Map<String,Object> demos() {
    List<Map<String,Object>> rows=db.many("select u.username,u.real_name,u.role_code,r.name role_name,u.dept,u.data_scope from sys_user u join sys_role r on r.code=u.role_code where u.status='1' order by r.sort_no,u.id");
    rows.forEach(row -> row.put("password", "admin".equals(row.get("username")) ? "admin123" : "123456")); return ok(rows);
  }
  @PostMapping("/logout") public Map<String,Object> logout(HttpServletRequest request) { return db.tx(user(request), ignored -> { UserPrincipal u=user(request); db.update("insert into sys_oper_log(user_id,username,action,res_type,res_key) values(:id,:name,'logout','auth',:role)",Map.of("id",u.id(),"name",u.username(),"role",u.role())); return ok(null,"已退出登录"); }); }

  private Map<String,Object> profile(UserPrincipal user, String roleName, Object last) {
    Map<String,Object> info=new LinkedHashMap<>(); info.put("id",user.id()); info.put("username",user.username()); info.put("realName",user.realName()); info.put("role",user.role()); info.put("roleName",roleName); info.put("dept",user.dept()); info.put("dataScope",user.dataScope()); info.put("lastLoginAt",last);
    Map<String,Object> out=new LinkedHashMap<>(); out.put("user",info); out.put("perms",acl.permissions(user.role())); out.put("menus",acl.menus(user.role())); return out;
  }
  private UserPrincipal principal(Map<String,Object> row) { return new UserPrincipal(((Number)row.get("id")).intValue(),String.valueOf(row.get("username")),String.valueOf(row.get("real_name")),String.valueOf(row.get("role_code")),(String)row.get("dept"),String.valueOf(row.get("data_scope"))); }
  public static UserPrincipal user(HttpServletRequest request) { return (UserPrincipal) request.getAttribute(AuthFilter.USER); }
}
