package com.crazy4lamb.crmbi.controller;

import static com.crazy4lamb.crmbi.controller.AuthController.user;
import static com.crazy4lamb.crmbi.core.Api.ok;

import com.crazy4lamb.crmbi.core.ApiException;
import com.crazy4lamb.crmbi.core.Db;
import com.crazy4lamb.crmbi.core.UserPrincipal;
import com.crazy4lamb.crmbi.service.AclService;
import jakarta.servlet.http.HttpServletRequest;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Collectors;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/crm")
public class CrmController {

  /** 需要校验为非负的数值字段。 */
  private static final List<String> MONEY_FIELDS = List.of(
      "amount", "cost", "credit_limit", "est_amount", "quantity", "win_rate", "capacity", "discount", "tax_rate");

  /** 需要解析为 LocalDate 的字段。 */
  private static final List<String> DATE_FIELDS = List.of(
      "expect_date", "sign_date", "start_date", "end_date", "order_date");

  private static final List<String> STAGES =
      List.of("初步接洽", "需求确认", "方案报价", "商务谈判", "赢单", "输单");

  private static final Map<String,Integer> RATES = Map.of(
      "初步接洽", 15, "需求确认", 35, "方案报价", 55, "商务谈判", 75, "赢单", 100, "输单", 0);

  /**
   * 实体元数据：一张表对应一组可搜索、可写、可过滤的列，以及它归属的菜单码。
   *
   * @param owned 是否带归属人字段（决定数据范围与自动归属）
   */
  record Entity(String table, String select, String joins, String order, Set<String> search,
                Set<String> write, Set<String> filter, String menu, boolean owned) {}

  private static Set<String> set(String values) {
    return Arrays.stream(values.split(","))
        .filter(v -> !v.isBlank())
        .collect(Collectors.toSet());
  }

  private static final Map<String,Entity> ENTITIES = buildEntities();

  private static Map<String,Entity> buildEntities() {
    Map<String,Entity> map = new LinkedHashMap<>();

    map.put("customer", new Entity(
        "crm_customer",
        "t.*, u.real_name owner_name",
        "left join sys_user u on u.id=t.owner_id",
        "t.id desc",
        set("name,cust_no,phone,industry,region"),
        set("cust_no,name,short_name,industry,region,level,source,status,credit_limit,"
            + "owner_id,owner_dept,phone,email,address,remark"),
        set("industry,region,level,source,status,owner_id"),
        "crm_customer", true));

    map.put("contact", new Entity(
        "crm_contact",
        "t.*, c.name customer_name",
        "left join crm_customer c on c.id=t.customer_id",
        "t.id desc",
        set("name,phone"),
        set("customer_id,name,position,phone,email,is_primary"),
        set("customer_id"),
        "crm_customer", false));

    map.put("lead", new Entity(
        "crm_lead",
        "t.*, p.name pool_name, u.real_name owner_name",
        "left join crm_lead_pool p on p.id=t.pool_id left join sys_user u on u.id=t.owner_id",
        "t.id desc",
        set("name,company,lead_no,phone"),
        set("lead_no,name,company,phone,wechat,industry,region,source,stage,intent_level,"
            + "est_amount,pool_id,owner_id,owner_dept,in_pool"),
        set("source,stage,intent_level,region,industry,pool_id,in_pool,owner_id"),
        "crm_lead", true));

    map.put("leadPool", new Entity(
        "crm_lead_pool",
        "t.*, u.real_name owner_name,"
            + " (select count(*)::int from crm_lead l where l.pool_id=t.id and l.in_pool) lead_count,"
            + " (select count(*)::int from crm_lead l where l.pool_id=t.id and l.in_pool"
            + " and l.stage='new') new_count",
        "left join sys_user u on u.id=t.owner_id",
        "t.id",
        set("name,code"),
        set("code,name,description,capacity,status,owner_id"),
        set("status"),
        "crm_lead_pool", false));

    map.put("opportunity", new Entity(
        "crm_opportunity",
        "t.*, c.name customer_name, u.real_name owner_name",
        "left join crm_customer c on c.id=t.customer_id left join sys_user u on u.id=t.owner_id",
        "t.id desc",
        set("name,opp_no"),
        set("opp_no,name,customer_id,lead_id,stage,est_amount,win_rate,expect_date,owner_id,owner_dept"),
        set("stage,owner_id,customer_id"),
        "crm_opportunity", true));

    map.put("contract", new Entity(
        "crm_contract",
        "t.*, c.name customer_name, c.industry, c.region, u.real_name owner_name",
        "left join crm_customer c on c.id=t.customer_id left join sys_user u on u.id=t.owner_id",
        "t.sign_date desc, t.id desc",
        set("name,contract_no"),
        set("contract_no,name,customer_id,opp_id,amount,cost,tax_rate,sign_date,start_date,"
            + "end_date,status,pay_type,owner_id,owner_dept"),
        set("status,pay_type,owner_id,customer_id"),
        "crm_contract", true));

    map.put("order", new Entity(
        "crm_order",
        "t.*, c.name customer_name, c.industry, c.region, u.real_name owner_name,"
            + " (select coalesce(sum(p.amount),0) from crm_payment p where p.order_id=t.id) paid_amount",
        "left join crm_customer c on c.id=t.customer_id left join sys_user u on u.id=t.owner_id",
        "t.order_date desc, t.id desc",
        set("order_no,product"),
        set("order_no,contract_id,customer_id,product,quantity,amount,cost,discount,status,"
            + "order_date,pay_date,owner_id,owner_dept"),
        set("status,product,owner_id,customer_id"),
        "crm_order", true));

    map.put("followUp", new Entity(
        "crm_follow_up",
        "t.*, u.real_name owner_name",
        "left join sys_user u on u.id=t.owner_id",
        "t.id desc",
        set("content,result"),
        set("biz_type,biz_id,content,way,result,next_time,owner_id"),
        set("biz_type,biz_id,way,result"),
        "crm_customer", false));

    return Map.copyOf(map);
  }

  private final Db db;
  private final AclService acl;

  public CrmController(Db db, AclService acl) {
    this.db = db;
    this.acl = acl;
  }

  // ------------------------------------------------------------------ 下拉字典

  @GetMapping("/options")
  public Map<String,Object> options() {
    Map<String,Object> out = new LinkedHashMap<>();
    out.put("industry", List.of("智能制造", "金融保险", "医疗健康", "教育培训", "互联网", "政府事业", "能源电力"));
    out.put("region", List.of("华东", "华北", "华南", "华中", "西南", "西北", "东北"));
    out.put("source", List.of("官网注册", "展会获客", "客户转介绍", "信息流广告", "电话陌拜", "线上活动"));
    out.put("level", List.of("A", "B", "C", "D"));
    out.put("intentLevel", List.of("高", "中", "低"));
    out.put("oppStage", STAGES);
    out.put("payType", List.of("一次性", "分期", "年付"));
    out.put("product", List.of("智学云课堂", "智慧书法平台", "AI 作业批改", "数据中台", "私有化部署", "运维服务包"));
    out.put("followWay", List.of("电话", "拜访", "微信", "邮件"));
    out.put("followResult", List.of("有意向", "需跟进", "已拒绝", "已成交"));
    out.put("customerStatus", pairs(
        "potential", "潜在客户", "active", "成交客户", "inactive", "流失客户"));
    out.put("leadStage", pairs(
        "new", "新线索", "following", "跟进中", "qualified", "已确认",
        "converted", "已转客户", "invalid", "无效"));
    out.put("contractStatus", pairs(
        "draft", "草稿", "approving", "审批中", "effective", "生效",
        "closed", "已完结", "void", "作废"));
    out.put("orderStatus", pairs(
        "pending", "待付款", "paid", "已付款", "delivered", "已交付",
        "done", "已完成", "refund", "已退款"));
    return ok(out);
  }

  @GetMapping("/picklist/{kind}")
  public Map<String,Object> picklist(@PathVariable String kind, HttpServletRequest request) {
    return db.tx(user(request), ignored -> {
      String sql = switch (kind) {
        case "customer"     -> "select id,name,cust_no from crm_customer order by id desc limit 500";
        case "contract"     -> "select id,name,contract_no,customer_id,amount from crm_contract"
                                 + " order by id desc limit 500";
        case "lead"         -> "select id,name,company,lead_no from crm_lead order by id desc limit 500";
        case "opportunity"  -> "select id,name,opp_no from crm_opportunity order by id desc limit 300";
        case "pool"         -> "select id,name,code from crm_lead_pool order by id";
        case "owner"        -> "select id,real_name name,dept from sys_user where status='1' order by id";
        default              -> null;
      };
      if (sql == null) return ok(List.of());

      List<Map<String,Object>> rows = db.many(sql);
      UserPrincipal user = user(request);
      // 非全局范围的用户只能看到本部门或本人的销售
      if ("owner".equals(kind) && !"all".equals(user.dataScope())) {
        rows = rows.stream()
            .filter(row -> "self".equals(user.dataScope())
                ? ((Number) row.get("id")).intValue() == user.id()
                : Objects.equals(row.get("dept"), user.dept()))
            .toList();
      }
      return ok(rows);
    });
  }

  // ------------------------------------------------------------------ 看板与汇总

  /** 商机看板：按阶段分道，每道取前 10 条并统计逾期。 */
  @GetMapping("/opportunity-board")
  public Map<String,Object> board(@RequestParam Map<String,String> query, HttpServletRequest request) {
    UserPrincipal user = user(request);
    requireMenu(user, "opportunity");
    return db.tx(user, ignored -> {
      Map<String,Object> params = new LinkedHashMap<>();
      List<String> conditions = new ArrayList<>();

      if (!blank(query.get("keyword"))) {
        params.put("keyword", "%" + query.get("keyword") + "%");
        conditions.add("(coalesce(t.name,'') || ' ' || coalesce(t.opp_no,'') || ' '"
            + " || coalesce(c.name,'')) ilike :keyword");
      }
      if (!blank(query.get("stage"))) {
        params.put("stage", query.get("stage"));
        conditions.add("t.stage = :stage");
      }
      String where = conditions.isEmpty() ? "" : " where " + String.join(" and ", conditions);

      String sql = """
          with ranked as (
            select t.*, c.name customer_name, u.real_name owner_name,
                   row_number() over(partition by t.stage order by t.expect_date nulls last, t.id desc) rn
            from crm_opportunity t
            left join crm_customer c on c.id=t.customer_id
            left join sys_user u on u.id=t.owner_id%s),
          grouped as (
            select stage, count(*)::int count, coalesce(sum(est_amount),0) amount,
                   count(*) filter(where expect_date < current_date
                       and stage not in ('赢单','输单'))::int overdue,
                   jsonb_agg(to_jsonb(ranked) - 'rn' order by rn) filter(where rn <= 10) rows
            from ranked group by stage)
          select * from grouped""".formatted(where);

      List<Map<String,Object>> lanes = db.many(sql, params);
      int total = lanes.stream().mapToInt(lane -> ((Number) lane.get("count")).intValue()).sum();
      return ok(Map.of("lanes", lanes, "total", total, "perStage", 10));
    });
  }

  @GetMapping("/{entity}/summary/stats")
  public Map<String,Object> summary(@PathVariable String entity, HttpServletRequest request) {
    Entity target = entity(entity);
    requireMenu(user(request), entity);
    return db.tx(user(request), ignored -> {
      String spec = switch (entity) {
        case "customer" -> "count(*)::int total,"
            + " count(*) filter(where status='active')::int active,"
            + " count(*) filter(where level='A')::int top,"
            + " coalesce(sum(credit_limit),0) amount";
        case "lead" -> "count(*)::int total,"
            + " count(*) filter(where in_pool)::int in_pool,"
            + " count(*) filter(where stage='converted')::int converted,"
            + " coalesce(sum(est_amount),0) amount";
        case "contract" -> "count(*)::int total,"
            + " count(*) filter(where status='effective')::int active,"
            + " coalesce(sum(amount),0) amount,"
            + " coalesce(sum(amount-cost),0) profit";
        case "order" -> "count(*)::int total,"
            + " count(*) filter(where status='pending')::int pending,"
            + " coalesce(sum(amount),0) amount,"
            + " coalesce(sum(quantity),0) quantity";
        case "opportunity" -> "count(*)::int total,"
            + " count(*) filter(where stage='赢单')::int won,"
            + " coalesce(sum(est_amount),0) amount,"
            + " coalesce(avg(win_rate),0) win_rate";
        default -> null;
      };
      return ok(spec == null ? Map.of() : db.one("select " + spec + " from " + target.table() + " t"));
    });
  }

  // ------------------------------------------------------------------ 客户公海

  @GetMapping("/customer-pool")
  public Map<String,Object> pool(@RequestParam Map<String,String> query, HttpServletRequest request) {
    return db.tx(user(request), ignored -> {
      int page = positive(query.get("page"), 1);
      int size = Math.min(200, positive(query.get("size"), 20));
      Map<String,Object> params = new LinkedHashMap<>();
      List<String> conditions = new ArrayList<>(List.of("c.status='potential'", "c.owner_id is null"));

      if (!blank(query.get("keyword"))) {
        params.put("keyword", "%" + query.get("keyword") + "%");
        conditions.add("(c.name ilike :keyword or c.cust_no ilike :keyword"
            + " or c.industry ilike :keyword or c.region ilike :keyword)");
      }
      for (String field : List.of("industry", "region", "level", "source")) {
        String value = query.get("f." + field);
        if (!blank(value)) {
          params.put(field, value);
          conditions.add("c." + field + " = :" + field);
        }
      }

      String where = " where " + String.join(" and ", conditions);
      params.put("limit", size);
      params.put("offset", (page - 1) * size);

      Number count = (Number) db.one(
          "select count(*) c from crm_customer c" + where, params).get("c");
      List<Map<String,Object>> rows = db.many(
          "select c.*, u.real_name owner_name from crm_customer c"
              + " left join sys_user u on u.id=c.owner_id" + where
              + " order by c.created_at desc limit :limit offset :offset", params);

      Map<String,Object> stat = db.one("""
          select count(*) filter(where status='potential' and owner_id is null)::int total,
                 count(*) filter(where status='potential' and owner_id is not null)::int claimed,
                 coalesce(sum(credit_limit) filter(where status='potential' and owner_id is null),0) pool_credit
          from crm_customer""");

      return ok(Map.of("rows", rows, "total", count, "page", page, "size", size, "stat", stat));
    });
  }

  @PostMapping("/customer-pool/{id}/claim")
  public Map<String,Object> claimCustomer(@PathVariable int id, HttpServletRequest request) {
    UserPrincipal user = user(request);
    if (!acl.can(user, "action", "customer-pool:claim") && !acl.can(user, "action", "customer:edit")) {
      throw ApiException.forbidden("无权限领取公海客户");
    }
    return db.tx(user, ignored -> {
      Map<String,Object> customer =
          db.one("select * from crm_customer where id=:id", Map.of("id", id));
      if (customer == null || !"potential".equals(customer.get("status")) || customer.get("owner_id") != null) {
        throw ApiException.bad("该客户不在公海（已被领取或状态不是潜在客户）");
      }
      // 条件更新保证并发下只有一人领到
      int changed = db.update(
          "update crm_customer set owner_id=:uid, owner_dept=:dept, updated_at=now()"
              + " where id=:id and owner_id is null and status='potential'",
          params("uid", user.id(), "dept", user.dept(), "id", id));
      if (changed == 0) throw new ApiException(409, "该客户已被领取，请刷新");
      return ok(null, "已领取 " + customer.get("cust_no") + "，归入你的名下");
    });
  }

  @PostMapping("/customer-pool/{id}/release")
  public Map<String,Object> releaseCustomer(@PathVariable int id, HttpServletRequest request) {
    UserPrincipal user = user(request);
    acl.require(user, "action", "customer-pool:release", "无权限退回公海");
    return db.tx(user, ignored -> {
      Map<String,Object> customer = record(ENTITIES.get("customer"), id);
      if (customer == null) throw ApiException.notFound("客户不存在");
      if (!"potential".equals(customer.get("status"))) {
        throw ApiException.bad("仅潜在客户可退回公海");
      }
      db.update("update crm_customer set owner_id=null, owner_dept=null, status='potential',"
          + " updated_at=now() where id=:id", Map.of("id", id));
      return ok(null, customer.get("cust_no") + " 已退回公海");
    });
  }

  // ------------------------------------------------------------------ 订单回款

  @GetMapping("/payment")
  public Map<String,Object> payments(@RequestParam Map<String,String> query, HttpServletRequest request) {
    requireMenu(user(request), "order");
    return db.tx(user(request), ignored -> {
      int page = positive(query.get("page"), 1);
      int size = Math.min(500, positive(query.get("size"), 20));
      Map<String,Object> params = new LinkedHashMap<>();
      List<String> conditions = new ArrayList<>();

      String[][] idFilters = {{"orderId", "o.id"}, {"contractId", "o.contract_id"}, {"customerId", "o.customer_id"}};
      for (String[] filter : idFilters) {
        if (!blank(query.get(filter[0]))) {
          params.put(filter[0], Integer.valueOf(query.get(filter[0])));
          conditions.add(filter[1] + " = :" + filter[0]);
        }
      }
      if (!blank(query.get("keyword"))) {
        params.put("keyword", "%" + query.get("keyword") + "%");
        conditions.add("(o.order_no ilike :keyword or c.name ilike :keyword or p.remark ilike :keyword)");
      }

      String where = conditions.isEmpty() ? "" : " where " + String.join(" and ", conditions);
      String join = " from crm_payment p join crm_order o on o.id=p.order_id"
          + " left join crm_customer c on c.id=o.customer_id";

      Number count = (Number) db.one("select count(*) c" + join + where, params).get("c");
      params.put("limit", size);
      params.put("offset", (page - 1) * size);

      List<Map<String,Object>> rows = db.many("""
          select p.*, o.order_no, o.amount order_amount, c.name customer_name,
                 (select coalesce(sum(p2.amount),0) from crm_payment p2 where p2.order_id=o.id) paid_amount,
                 o.status order_status%s%s
          order by p.pay_date desc, p.id desc limit :limit offset :offset""".formatted(join, where), params);

      return ok(Map.of("rows", rows, "total", count, "page", page, "size", size));
    });
  }

  @PostMapping("/payment")
  public Map<String,Object> addPayment(@RequestBody Map<String,Object> body, HttpServletRequest request) {
    UserPrincipal user = user(request);
    if (!acl.can(user, "action", "payment:add") && !acl.can(user, "action", "order:edit")) {
      throw ApiException.forbidden("无权限登记回款");
    }
    return db.tx(user, ignored -> {
      Number orderId = number(body.get("orderId"));
      BigDecimal amount = decimal(body.get("amount"));
      LocalDate payDate = null;
      try {
        payDate = LocalDate.parse(String.valueOf(body.get("payDate")));
      } catch (RuntimeException parseError) {
        // 保持 null，由下面的校验统一报错
      }
      if (orderId == null || amount == null || amount.compareTo(new BigDecimal("0.01")) < 0 || payDate == null) {
        throw ApiException.bad("订单 / 有效金额 / 回款日期必填");
      }

      // 行锁避免并发回款导致累计额超出订单金额
      Map<String,Object> order =
          db.one("select * from crm_order where id=:id for update", Map.of("id", orderId));
      if (order == null) throw ApiException.notFound("订单不存在");

      Number id = db.insertId("""
          insert into crm_payment(order_id,amount,pay_date,method,remark,owner_id)
          values(:orderId,:amount,:payDate,:method,:remark,:owner)""",
          params("orderId", orderId, "amount", amount, "payDate", payDate,
              "method", body.getOrDefault("method", "对公转账"),
              "remark", body.get("remark"), "owner", user.id()));

      Map<String,Object> balance = db.one(
          "select paid_amount, amount from crm_order_balance where id=:id", Map.of("id", orderId));
      return ok(Map.of("id", id),
          "回款已登记，该订单累计回款 " + balance.get("paid_amount") + "/" + balance.get("amount"));
    });
  }

  // ------------------------------------------------------------------ 线索与商机

  @PostMapping("/lead/{id}/claim")
  public Map<String,Object> claimLead(@PathVariable int id, HttpServletRequest request) {
    UserPrincipal user = user(request);
    acl.require(user, "action", "lead:claim", "无权限领取线索");
    return db.tx(user, ignored -> {
      int changed = db.update("""
          update crm_lead set in_pool=false, owner_id=:uid, owner_dept=:dept, claim_time=now(),
                 stage = case when stage='new' then 'following' else stage end, updated_at=now()
          where id=:id and in_pool=true""",
          params("uid", user.id(), "dept", user.dept(), "id", id));
      if (changed == 0) throw ApiException.bad("该线索已被其他销售领取");
      return ok(null, "领取成功，该线索已归入你的名下");
    });
  }

  @PostMapping("/lead/{id}/assign")
  public Map<String,Object> assignLead(@PathVariable int id, @RequestBody Map<String,Object> body,
                                       HttpServletRequest request) {
    UserPrincipal user = user(request);
    acl.require(user, "action", "lead:assign", "无权限分配线索");
    return db.tx(user, ignored -> {
      Number ownerId = number(body.get("ownerId"));
      Map<String,Object> owner = ownerId == null ? null
          : db.one("select id,real_name,dept,status from sys_user where id=:id", Map.of("id", ownerId));
      if (owner == null || !"1".equals(owner.get("status"))) {
        throw ApiException.bad("目标销售不存在或已停用");
      }
      if ("dept".equals(user.dataScope()) && !Objects.equals(owner.get("dept"), user.dept())) {
        throw ApiException.forbidden("不能分配给其他部门的销售");
      }
      db.update("""
          update crm_lead set owner_id=:owner, owner_dept=:dept, in_pool=false,
                 claim_time=now(), updated_at=now() where id=:id""",
          params("owner", ownerId, "dept", owner.get("dept"), "id", id));
      return ok(null, "已分配给 " + owner.get("real_name"));
    });
  }

  @PostMapping("/lead/{id}/convert")
  public Map<String,Object> convertLead(@PathVariable int id, HttpServletRequest request) {
    UserPrincipal user = user(request);
    acl.require(user, "action", "lead:edit", "无权限转化线索");
    return db.tx(user, ignored -> {
      Map<String,Object> result = db.one("select * from crm_convert_lead(:id)", Map.of("id", id));
      return ok(Map.of("customerId", result.get("customer_id"), "custNo", result.get("cust_no")),
          "已转化为客户：" + result.get("cust_no"));
    });
  }

  @PostMapping("/opp/{id}/advance")
  public Map<String,Object> advance(@PathVariable int id, HttpServletRequest request) {
    UserPrincipal user = user(request);
    acl.require(user, "action", "opp:edit", "无权限推进商机");
    return db.tx(user, ignored -> {
      Map<String,Object> opportunity = record(ENTITIES.get("opportunity"), id);
      if (opportunity == null) throw ApiException.notFound("商机不存在");

      String stage = String.valueOf(opportunity.get("stage"));
      if ("赢单".equals(stage) || "输单".equals(stage)) {
        throw ApiException.bad("商机已结束，不能继续推进");
      }
      int index = STAGES.indexOf(stage);
      if (index < 0 || index + 1 >= STAGES.size()) {
        throw ApiException.bad("商机阶段无效，请先编辑阶段");
      }

      String next = STAGES.get(index + 1);
      db.update("""
          update crm_opportunity set stage=:stage, win_rate=:rate,
                 closed_at = case when :stage in ('赢单','输单') then now() else closed_at end
          where id=:id""",
          Map.of("stage", next, "rate", RATES.get(next), "id", id));
      return ok(Map.of("nextStage", next, "winRate", RATES.get(next)),
          "已推进到「" + next + "」，赢单率 " + RATES.get(next) + "%");
    });
  }

  // ------------------------------------------------------------------ 客户 360

  @GetMapping("/customer/{id}/360")
  public Map<String,Object> customer360(@PathVariable int id, HttpServletRequest request) {
    requireMenu(user(request), "customer");
    return db.tx(user(request), ignored -> {
      Map<String,Object> params = Map.of("id", id);

      Map<String,Object> customer = db.one("""
          select t.*, u.real_name owner_name from crm_customer t
          left join sys_user u on u.id=t.owner_id where t.id=:id""", params);
      if (customer == null) throw ApiException.notFound("客户不存在");

      List<Map<String,Object>> contacts = db.many(
          "select * from crm_contact where customer_id=:id order by is_primary desc, id", params);
      List<Map<String,Object>> contracts = db.many(
          "select * from crm_contract where customer_id=:id order by sign_date desc limit 20", params);
      List<Map<String,Object>> orders = db.many("""
          select o.*, (select coalesce(sum(amount),0) from crm_payment where order_id=o.id) paid_amount
          from crm_order o where o.customer_id=:id order by order_date desc limit 20""", params);
      List<Map<String,Object>> opportunities = db.many(
          "select * from crm_opportunity where customer_id=:id order by id desc limit 20", params);
      List<Map<String,Object>> leads = db.many(
          "select * from crm_lead where customer_id=:id order by id desc limit 20", params);
      List<Map<String,Object>> follows = db.many("""
          select f.*, u.real_name owner_name from crm_follow_up f
          left join sys_user u on u.id=f.owner_id
          where f.biz_type='customer' and f.biz_id=:id order by f.created_at desc limit 50""", params);

      Map<String,Object> summary = db.one("""
          select coalesce((select sum(amount) from crm_contract where customer_id=:id),0) contract_amount,
                 (select count(*)::int from crm_contract where customer_id=:id) contract_cnt,
                 coalesce((select sum(amount) from crm_order where customer_id=:id),0) order_amount,
                 (select count(*)::int from crm_order where customer_id=:id) order_cnt,
                 coalesce((select sum(p.amount) from crm_payment p
                           join crm_order o on o.id=p.order_id where o.customer_id=:id),0) paid_amount,
                 coalesce((select sum(o.amount) - sum(coalesce(x.paid,0)) from crm_order o
                           left join lateral(select sum(amount) paid from crm_payment where order_id=o.id) x on true
                           where o.customer_id=:id and o.status<>'refund'),0) receivable_amount""", params);

      List<Map<String,Object>> journey = db.many("""
          select * from (
            select 'lead' event_type, id entity_id, coalesce(converted_at,created_at) occurred_at,
                   case when customer_id is not null then '线索转化为客户' else '线索进入系统' end title,
                   coalesce(company,name) detail
              from crm_lead where customer_id=:id
            union all
            select 'opportunity', id, created_at, '创建商机', name || ' · ' || coalesce(stage,'')
              from crm_opportunity where customer_id=:id
            union all
            select 'contract', id, sign_date::timestamp, '签署合同', name || ' · ¥' || amount
              from crm_contract where customer_id=:id
            union all
            select 'order', id, order_date::timestamp, '创建订单', coalesce(product,'订单') || ' · ¥' || amount
              from crm_order where customer_id=:id
            union all
            select 'payment', p.id, p.pay_date::timestamp, '收到回款', '¥' || p.amount
              from crm_payment p join crm_order o on o.id=p.order_id where o.customer_id=:id
            union all
            select 'followUp', id, created_at, '客户跟进', coalesce(content,'')
              from crm_follow_up where biz_type='customer' and biz_id=:id
          ) j order by occurred_at desc nulls last limit 100""", params);

      Map<String,Object> out = new LinkedHashMap<>();
      out.put("customer", customer);
      out.put("contacts", contacts);
      out.put("contracts", contracts);
      out.put("orders", orders);
      out.put("opportunities", opportunities);
      out.put("leads", leads);
      out.put("follows", follows);
      out.put("journey", journey);
      out.put("summary", Map.of(
          "contractAmount", summary.get("contract_amount"),
          "contractCnt", summary.get("contract_cnt"),
          "orderAmount", summary.get("order_amount"),
          "orderCnt", summary.get("order_cnt"),
          "paidAmount", summary.get("paid_amount"),
          "receivableAmount", summary.get("receivable_amount")));
      return ok(out);
    });
  }

  // ------------------------------------------------------------------ 通用 CRUD

  @GetMapping("/{entity}")
  public Map<String,Object> list(@PathVariable String entity,
                                 @RequestParam Map<String,String> query,
                                 HttpServletRequest request) {
    Entity target = entity(entity);
    requireMenu(user(request), entity);
    return db.tx(user(request), ignored -> {
      int page = positive(query.get("page"), 1);
      int size = Math.min(500, positive(query.get("size"), 20));
      Map<String,Object> params = new LinkedHashMap<>();
      List<String> conditions = new ArrayList<>();

      if (!blank(query.get("keyword"))) {
        params.put("keyword", "%" + query.get("keyword") + "%");
        String matches = target.search().stream()
            .map(field -> "coalesce(cast(t." + field + " as text),'') ilike :keyword")
            .collect(Collectors.joining(" or "));
        conditions.add("(" + matches + ")");
      }
      for (Map.Entry<String,String> entry : query.entrySet()) {
        if (!entry.getKey().startsWith("f.")) continue;
        String field = entry.getKey().substring(2);
        // 只允许过滤白名单内的列，避免拼出任意外部列
        if ((target.filter().contains(field) || target.write().contains(field)) && !blank(entry.getValue())) {
          params.put("f_" + field, coerce(entry.getValue()));
          conditions.add("t." + field + " = :f_" + field);
        }
      }

      String where = conditions.isEmpty() ? "" : " where " + String.join(" and ", conditions);
      Number total = (Number) db.one(
          "select count(*) c from " + target.table() + " t " + where, params).get("c");

      String sort = target.write().contains(query.get("sortBy"))
          ? "t." + query.get("sortBy") + ("asc".equalsIgnoreCase(query.get("sortDir")) ? " asc" : " desc")
          : target.order();

      params.put("limit", size);
      params.put("offset", (page - 1) * size);
      List<Map<String,Object>> rows = db.many(
          "select " + target.select() + " from " + target.table() + " t " + target.joins() + where
              + " order by " + sort + " limit :limit offset :offset", params);

      return ok(Map.of("rows", rows, "total", total, "page", page, "size", size));
    });
  }

  @GetMapping("/{entity}/{id}")
  public Map<String,Object> detail(@PathVariable String entity, @PathVariable String id,
                                   HttpServletRequest request) {
    if (!id.matches("[1-9]\\d*")) throw ApiException.bad("记录编号必须是正整数");
    Entity target = entity(entity);
    requireMenu(user(request), entity);
    return db.tx(user(request), ignored -> {
      Map<String,Object> row = db.one(
          "select " + target.select() + " from " + target.table() + " t " + target.joins()
              + " where t.id=:id", Map.of("id", Integer.valueOf(id)));
      if (row == null) throw ApiException.notFound("记录不存在或不在当前数据范围内");
      return ok(row);
    });
  }

  @PostMapping("/{entity}")
  public Map<String,Object> create(@PathVariable String entity, @RequestBody Map<String,Object> body,
                                   HttpServletRequest request) {
    Entity target = entity(entity);
    UserPrincipal user = user(request);
    requireMenu(user, entity);
    requireAction(user, entity + ":add");
    return db.tx(user, ignored -> {
      Map<String,Object> values = writeValues(target, body, user, true, entity);
      if ("followUp".equals(entity)) validateFollowUp(values, user);
      if (values.isEmpty()) throw ApiException.bad("没有可保存的字段");

      String columns = String.join(",", values.keySet());
      String named = values.keySet().stream().map(key -> ":" + key).collect(Collectors.joining(","));
      Number id = db.insertId(
          "insert into " + target.table() + "(" + columns + ") values(" + named + ")", values);
      return ok(Map.of("id", id), "已创建");
    });
  }

  @PutMapping("/{entity}/{id}")
  public Map<String,Object> update(@PathVariable String entity, @PathVariable int id,
                                   @RequestBody Map<String,Object> body, HttpServletRequest request) {
    Entity target = entity(entity);
    UserPrincipal user = user(request);
    requireMenu(user, entity);
    requireAction(user, entity + ":edit");
    return db.tx(user, ignored -> {
      if (record(target, id) == null) throw ApiException.notFound("记录不存在或不在当前数据范围内");
      Map<String,Object> values = writeValues(target, body, user, false, entity);
      if (values.isEmpty()) return ok(null, "未发生变化");

      values.put("id", id);
      String sets = values.keySet().stream()
          .filter(key -> !"id".equals(key))
          .map(key -> key + " = :" + key)
          .collect(Collectors.joining(","));
      if (target.write().contains("updated_at")) sets += ", updated_at=now()";

      db.update("update " + target.table() + " set " + sets + " where id=:id", values);
      return ok(null, "已保存");
    });
  }

  @DeleteMapping("/{entity}/{id}")
  public Map<String,Object> delete(@PathVariable String entity, @PathVariable int id,
                                   HttpServletRequest request) {
    Entity target = entity(entity);
    UserPrincipal user = user(request);
    requireMenu(user, entity);
    return db.tx(user, ignored -> {
      if (record(target, id) == null) throw ApiException.notFound("记录不存在或不在当前数据范围内");
      if (!user.admin()) requireAction(user, entity + ":delete");
      db.update("delete from " + target.table() + " where id=:id", Map.of("id", id));
      return ok(null, "已删除");
    });
  }

  // ------------------------------------------------------------------ 校验与工具

  /** 跟进记录必须关联一条在当前数据范围内可见的业务记录。 */
  private void validateFollowUp(Map<String,Object> values, UserPrincipal user) {
    values.put("owner_id", user.id());
    String content = String.valueOf(values.getOrDefault("content", "")).trim();
    if (content.isEmpty() || content.length() > 500) {
      throw ApiException.bad("跟进内容须为 1–500 字");
    }
    String bizType = String.valueOf(values.get("biz_type"));
    Number bizId = number(values.get("biz_id"));
    Entity target = Map.of(
        "customer", ENTITIES.get("customer"),
        "opportunity", ENTITIES.get("opportunity"),
        "lead", ENTITIES.get("lead")).get(bizType);
    if (target == null || bizId == null || record(target, bizId.intValue()) == null) {
      throw ApiException.bad("关联业务不存在或不在当前数据范围内");
    }
  }

  private Entity entity(String name) {
    Entity target = ENTITIES.get(name);
    if (target == null) throw ApiException.notFound("未知实体");
    return target;
  }

  private Map<String,Object> record(Entity target, int id) {
    return db.one("select * from " + target.table() + " where id=:id", Map.of("id", id));
  }

  /** 菜单鉴权：按实体的菜单码判断，内部完成实体名到菜单码的转换。 */
  private void requireMenu(UserPrincipal user, String entity) {
    Entity target = ENTITIES.get(entity);
    if (target != null && !acl.can(user, "menu", target.menu())) {
      throw ApiException.forbidden("无权限访问该业务模块");
    }
  }

  /** 操作鉴权：把实体名归一到权限字典里的动作码。 */
  private void requireAction(UserPrincipal user, String action) {
    if (user.admin()) return;
    String normalized = action
        .replace("opportunity:", "opp:")
        .replace("followUp:", "follow:")
        .replace("contact:", "customer:")
        .replace("leadPool:", "lead:");
    if (!acl.can(user, "action", normalized)) {
      throw ApiException.forbidden("无权限执行该操作");
    }
  }

  /** 只接受可写白名单内的字段，并完成归属、金额、日期的类型归一。 */
  private Map<String,Object> writeValues(Entity target, Map<String,Object> body,
                                          UserPrincipal user, boolean create, String entity) {
    Map<String,Object> out = new LinkedHashMap<>();
    for (String key : target.write()) {
      if (body.containsKey(key)) out.put(key, body.get(key));
    }

    if (target.owned()) {
      if (create && out.get("owner_id") == null) {
        out.put("owner_id", user.id());
        out.put("owner_dept", user.dept());
      } else if (out.get("owner_id") != null) {
        Number ownerId = number(out.get("owner_id"));
        Map<String,Object> owner = db.one(
            "select id,dept from sys_user where id=:id and status='1'", Map.of("id", ownerId));
        if (owner == null) throw ApiException.bad("归属人不存在或已停用");
        if ("self".equals(user.dataScope()) && ownerId.intValue() != user.id()) {
          throw ApiException.forbidden("归属人超出当前数据范围");
        }
        if ("dept".equals(user.dataScope()) && !Objects.equals(owner.get("dept"), user.dept())) {
          throw ApiException.forbidden("归属人超出当前数据范围");
        }
        out.put("owner_id", ownerId);
        out.put("owner_dept", owner.get("dept"));
      }
    }

    for (String field : MONEY_FIELDS) {
      if (out.get(field) == null) continue;
      BigDecimal value = decimal(out.get(field));
      if (value == null || value.signum() < 0) {
        throw ApiException.bad("请填写有效的金额、数量或比例");
      }
      if ("win_rate".equals(field) && value.compareTo(BigDecimal.valueOf(100)) > 0) {
        throw ApiException.bad("赢单率不能超过 100");
      }
      if (("discount".equals(field) || "tax_rate".equals(field))
          && value.compareTo(BigDecimal.ONE) > 0) {
        throw ApiException.bad("折扣与税率必须在 0 与 1 之间");
      }
      out.put(field, value);
    }

    for (String field : DATE_FIELDS) {
      if (!(out.get(field) instanceof String value) || value.isBlank()) continue;
      try {
        out.put(field, LocalDate.parse(value));
      } catch (RuntimeException e) {
        throw ApiException.bad("日期格式无效：" + field);
      }
    }
    if (out.get("next_time") instanceof String value && !value.isBlank()) {
      try {
        out.put("next_time", LocalDateTime.parse(value));
      } catch (RuntimeException e) {
        throw ApiException.bad("时间格式无效：next_time");
      }
    }
    if ("opportunity".equals(entity) && out.get("stage") != null
        && !STAGES.contains(String.valueOf(out.get("stage")))) {
      throw ApiException.bad("商机阶段无效");
    }
    return out;
  }

  private static List<Map<String,Object>> pairs(String... values) {
    List<Map<String,Object>> out = new ArrayList<>();
    for (int i = 0; i < values.length; i += 2) {
      out.add(Map.of("value", values[i], "label", values[i + 1]));
    }
    return out;
  }

  private static Map<String,Object> params(Object... values) {
    Map<String,Object> out = new LinkedHashMap<>();
    for (int i = 0; i < values.length; i += 2) out.put(String.valueOf(values[i]), values[i + 1]);
    return out;
  }

  private static boolean blank(String value) {
    return value == null || value.isBlank();
  }

  private static int positive(String value, int fallback) {
    try {
      return Math.max(1, Integer.parseInt(value));
    } catch (RuntimeException e) {
      return fallback;
    }
  }

  private static Object coerce(String value) {
    if ("true".equals(value) || "false".equals(value)) return Boolean.valueOf(value);
    try {
      return Integer.valueOf(value);
    } catch (NumberFormatException e) {
      return value;
    }
  }

  private static Number number(Object value) {
    try {
      return value instanceof Number n ? n : Integer.valueOf(String.valueOf(value));
    } catch (RuntimeException e) {
      return null;
    }
  }

  private static BigDecimal decimal(Object value) {
    try {
      return value instanceof BigDecimal d ? d : new BigDecimal(String.valueOf(value));
    } catch (RuntimeException e) {
      return null;
    }
  }
}