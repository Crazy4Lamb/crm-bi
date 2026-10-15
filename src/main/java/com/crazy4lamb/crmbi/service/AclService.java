package com.crazy4lamb.crmbi.service;

import com.crazy4lamb.crmbi.core.ApiException;
import com.crazy4lamb.crmbi.core.Db;
import com.crazy4lamb.crmbi.core.UserPrincipal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

/** 基于 sys_acl 表的权限判定：菜单可见性、动作授权、卡片/图表/报表资源授权。 */
@Service
public class AclService {
  private final Db db;

  public AclService(Db db) {
    this.db = db;
  }

  /** 某角色在六类资源上的完整授权清单，未出现的类型给空列表。 */
  public Map<String,List<String>> permissions(String role) {
    Map<String,List<String>> out = new LinkedHashMap<>();
    for (String type : List.of("menu", "action", "card", "chart", "dashboard", "report")) {
      out.put(type, new ArrayList<>());
    }
    for (Map<String,Object> row
        : db.many("select res_type, res_key from sys_acl where role_code = :role", Map.of("role", role))) {
      out.computeIfAbsent(String.valueOf(row.get("res_type")), key -> new ArrayList<>())
          .add(String.valueOf(row.get("res_key")));
    }
    return out;
  }

  /** 管理员对所有资源短路放行。 */
  public boolean can(UserPrincipal user, String type, String key) {
    return user.admin() || permissions(user.role()).getOrDefault(type, List.of()).contains(key);
  }

  public void require(UserPrincipal user, String type, String key, String message) {
    if (!can(user, type, key)) throw ApiException.forbidden(message);
  }

  /** 构建当前角色可见的菜单树（只保留已授权的父子节点）。 */
  public List<Map<String,Object>> menus(String role) {
    Map<String,List<String>> perms = permissions(role);
    List<Map<String,Object>> all = db.many(
        "select code, name, path, icon, parent_code from sys_menu order by sort_no, code");

    List<Map<String,Object>> roots = new ArrayList<>();
    for (Map<String,Object> item : all) {
      if (item.get("parent_code") != null) continue;
      if (!perms.get("menu").contains(String.valueOf(item.get("code")))) continue;

      Map<String,Object> root = new LinkedHashMap<>(item);
      root.remove("parent_code");
      root.put("children", all.stream()
          .filter(child -> item.get("code").equals(child.get("parent_code")))
          .filter(child -> perms.get("menu").contains(String.valueOf(child.get("code"))))
          .map(child -> {
            Map<String,Object> copy = new LinkedHashMap<>(child);
            copy.remove("parent_code");
            return copy;
          })
          .toList());
      roots.add(root);
    }
    return roots;
  }
}
