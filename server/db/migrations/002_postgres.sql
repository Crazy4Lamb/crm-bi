-- PostgreSQL-native business integrity, search, row security and analytics.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE FUNCTION crm_scope_matches(p_owner integer, p_dept text) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(current_setting('crm.data_scope',true) = 'all'
    OR (current_setting('crm.data_scope',true) = 'self' AND p_owner = nullif(current_setting('crm.user_id',true),'')::integer)
    OR (current_setting('crm.data_scope',true) = 'dept' AND p_dept = current_setting('crm.dept',true)),false)
$$;

DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('customer','C','cust_no',10001),('lead','L','lead_no',20001),
    ('opportunity','O','opp_no',30001),('contract','HT','contract_no',50001),
    ('order','DD','order_no',80001),('lead_pool','POOL','code',1)
  ) AS v(entity,prefix,field,start_no) LOOP
    EXECUTE format('CREATE SEQUENCE crm_%s_code_seq START %s',item.entity,item.start_no);
  END LOOP;
END $$;

CREATE FUNCTION crm_next_code(p_entity text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE prefix text; seq regclass; value text; BEGIN
  CASE p_entity
    WHEN 'customer' THEN prefix:='C'; seq:='public.crm_customer_code_seq';
    WHEN 'lead' THEN prefix:='L'; seq:='public.crm_lead_code_seq';
    WHEN 'opportunity' THEN prefix:='O'; seq:='public.crm_opportunity_code_seq';
    WHEN 'contract' THEN prefix:='HT'; seq:='public.crm_contract_code_seq';
    WHEN 'order' THEN prefix:='DD'; seq:='public.crm_order_code_seq';
    WHEN 'leadPool' THEN prefix:='POOL'; seq:='public.crm_lead_pool_code_seq';
    ELSE RAISE EXCEPTION 'Unsupported entity' USING ERRCODE='22023';
  END CASE;
  value := nextval(seq)::text;
  RETURN prefix || lpad(value,greatest(5,length(value)),'0');
END $$;

CREATE FUNCTION crm_sync_code_sequences() RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE item record; max_no bigint; BEGIN
  IF coalesce(current_setting('crm.role',true),'') NOT IN ('admin','system') THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
  FOR item IN SELECT * FROM (VALUES
    ('customer','cust_no',10000),('lead','lead_no',20000),('opportunity','opp_no',30000),
    ('contract','contract_no',50000),('order','order_no',80000),('lead_pool','code',0)
  ) AS v(entity,field,min_no) LOOP
    EXECUTE format('SELECT greatest(coalesce(max(nullif(regexp_replace(%I,''[^0-9]'','''',''g''),'''')::bigint),0),%s) FROM public.crm_%s',item.field,item.min_no,item.entity) INTO max_no;
    PERFORM setval(('public.crm_'||item.entity||'_code_seq')::regclass,greatest(max_no,1),max_no>0);
  END LOOP;
END $$;

CREATE FUNCTION crm_fill_code() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(to_jsonb(NEW)->>TG_ARGV[1],'')='' THEN
    NEW := jsonb_populate_record(NEW,jsonb_build_object(TG_ARGV[1],crm_next_code(TG_ARGV[0])));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_code BEFORE INSERT ON crm_customer FOR EACH ROW EXECUTE FUNCTION crm_fill_code('customer','cust_no');
CREATE TRIGGER lead_code BEFORE INSERT ON crm_lead FOR EACH ROW EXECUTE FUNCTION crm_fill_code('lead','lead_no');
CREATE TRIGGER opportunity_code BEFORE INSERT ON crm_opportunity FOR EACH ROW EXECUTE FUNCTION crm_fill_code('opportunity','opp_no');
CREATE TRIGGER contract_code BEFORE INSERT ON crm_contract FOR EACH ROW EXECUTE FUNCTION crm_fill_code('contract','contract_no');
CREATE TRIGGER order_code BEFORE INSERT ON crm_order FOR EACH ROW EXECUTE FUNCTION crm_fill_code('order','order_no');
CREATE TRIGGER pool_code BEFORE INSERT ON crm_lead_pool FOR EACH ROW EXECUTE FUNCTION crm_fill_code('leadPool','code');

ALTER TABLE crm_customer ADD CONSTRAINT customer_credit_nonnegative CHECK (credit_limit>=0);
ALTER TABLE crm_lead ADD CONSTRAINT lead_amount_nonnegative CHECK (est_amount>=0);
ALTER TABLE crm_opportunity ADD CONSTRAINT opportunity_amount_nonnegative CHECK (est_amount>=0),
  ADD CONSTRAINT opportunity_win_rate_valid CHECK (win_rate BETWEEN 0 AND 100),
  ADD CONSTRAINT opportunity_stage_valid CHECK (stage IN ('初步接洽','需求确认','方案报价','商务谈判','赢单','输单'));
ALTER TABLE crm_contract ADD CONSTRAINT contract_amount_valid CHECK (amount>=0 AND cost>=0),
  ADD CONSTRAINT contract_tax_valid CHECK (tax_rate BETWEEN 0 AND 1),
  ADD CONSTRAINT contract_dates_valid CHECK (end_date IS NULL OR start_date IS NULL OR end_date>=start_date);
ALTER TABLE crm_order ADD CONSTRAINT order_amount_valid CHECK (amount>=0 AND cost>=0),
  ADD CONSTRAINT order_quantity_valid CHECK (quantity>0),
  ADD CONSTRAINT order_discount_valid CHECK (discount BETWEEN 0 AND 1);
ALTER TABLE crm_payment ADD CONSTRAINT payment_positive CHECK (amount>0);
ALTER TABLE crm_follow_up ADD CONSTRAINT follow_business_valid CHECK (biz_type IN ('customer','lead','opportunity','contract'));

CREATE INDEX customer_search_trgm ON crm_customer USING gin ((coalesce(name,'')||' '||coalesce(cust_no,'')||' '||coalesce(phone,'')||' '||coalesce(industry,'')||' '||coalesce(region,'')) gin_trgm_ops);
CREATE INDEX lead_search_trgm ON crm_lead USING gin ((coalesce(name,'')||' '||coalesce(company,'')||' '||coalesce(lead_no,'')||' '||coalesce(phone,'')) gin_trgm_ops);
CREATE INDEX customer_owner_created ON crm_customer(owner_id,created_at DESC);
CREATE INDEX customer_dept_created ON crm_customer(owner_dept,created_at DESC);
CREATE INDEX customer_pool_created ON crm_customer(created_at DESC) WHERE owner_id IS NULL AND status='potential';
CREATE INDEX lead_pool_pending ON crm_lead(pool_id,id DESC) WHERE in_pool;
CREATE INDEX opportunity_owner_stage ON crm_opportunity(owner_id,stage,expect_date);
CREATE INDEX opportunity_dept_stage ON crm_opportunity(owner_dept,stage,expect_date);
CREATE INDEX contract_owner_date ON crm_contract(owner_id,sign_date DESC);
CREATE INDEX contract_dept_date ON crm_contract(owner_dept,sign_date DESC);
CREATE INDEX order_owner_date ON crm_order(owner_id,order_date DESC);
CREATE INDEX order_dept_date ON crm_order(owner_dept,order_date DESC);
CREATE INDEX follow_owner_next ON crm_follow_up(owner_id,next_time) WHERE next_time IS NOT NULL;
CREATE INDEX widget_style_gin ON bi_widget USING gin(style jsonb_path_ops);

-- Database enforcement is independent of the API's explicit filtering.
ALTER TABLE crm_customer ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_customer FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_read ON crm_customer FOR SELECT USING (crm_scope_matches(owner_id,owner_dept) OR (owner_id IS NULL AND status='potential'));
CREATE POLICY customer_insert ON crm_customer FOR INSERT WITH CHECK (crm_scope_matches(owner_id,owner_dept));
CREATE POLICY customer_update ON crm_customer FOR UPDATE USING (crm_scope_matches(owner_id,owner_dept) OR (owner_id IS NULL AND status='potential')) WITH CHECK (crm_scope_matches(owner_id,owner_dept) OR (owner_id IS NULL AND status='potential'));
CREATE POLICY customer_delete ON crm_customer FOR DELETE USING (crm_scope_matches(owner_id,owner_dept));

ALTER TABLE crm_lead ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_lead FORCE ROW LEVEL SECURITY;
CREATE POLICY lead_read ON crm_lead FOR SELECT USING (crm_scope_matches(owner_id,owner_dept) OR in_pool);
CREATE POLICY lead_insert ON crm_lead FOR INSERT WITH CHECK (crm_scope_matches(owner_id,owner_dept));
CREATE POLICY lead_update ON crm_lead FOR UPDATE USING (crm_scope_matches(owner_id,owner_dept) OR in_pool) WITH CHECK (crm_scope_matches(owner_id,owner_dept) OR in_pool);
CREATE POLICY lead_delete ON crm_lead FOR DELETE USING (crm_scope_matches(owner_id,owner_dept));

DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['crm_opportunity','crm_contract','crm_order'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
    EXECUTE format('CREATE POLICY owner_scope ON %I USING (crm_scope_matches(owner_id,owner_dept)) WITH CHECK (crm_scope_matches(owner_id,owner_dept))',tbl);
  END LOOP;
END $$;
ALTER TABLE crm_contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_contact FORCE ROW LEVEL SECURITY;
CREATE POLICY contact_scope ON crm_contact USING (EXISTS(SELECT 1 FROM crm_customer c WHERE c.id=customer_id)) WITH CHECK(EXISTS(SELECT 1 FROM crm_customer c WHERE c.id=customer_id));
ALTER TABLE crm_payment ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_payment FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_scope ON crm_payment USING (EXISTS(SELECT 1 FROM crm_order o WHERE o.id=order_id)) WITH CHECK(EXISTS(SELECT 1 FROM crm_order o WHERE o.id=order_id));
ALTER TABLE crm_follow_up ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_follow_up FORCE ROW LEVEL SECURITY;
CREATE POLICY follow_scope ON crm_follow_up USING (
  (biz_type='customer' AND EXISTS(SELECT 1 FROM crm_customer c WHERE c.id=biz_id)) OR
  (biz_type='lead' AND EXISTS(SELECT 1 FROM crm_lead l WHERE l.id=biz_id)) OR
  (biz_type='opportunity' AND EXISTS(SELECT 1 FROM crm_opportunity o WHERE o.id=biz_id)) OR
  (biz_type='contract' AND EXISTS(SELECT 1 FROM crm_contract c WHERE c.id=biz_id))
);

CREATE FUNCTION crm_convert_lead(p_id integer) RETURNS TABLE(customer_id integer,cust_no text)
LANGUAGE plpgsql AS $$
DECLARE l crm_lead%ROWTYPE; c_id integer; c_code text; BEGIN
  SELECT * INTO l FROM crm_lead WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '线索不存在或不在数据范围内' USING ERRCODE='P0002'; END IF;
  IF l.customer_id IS NOT NULL THEN RAISE EXCEPTION '该线索已转为客户' USING ERRCODE='23505'; END IF;
  IF l.in_pool THEN RAISE EXCEPTION '请先领取线索再转化' USING ERRCODE='22023'; END IF;
  INSERT INTO crm_customer(name,industry,region,source,level,status,phone,owner_id,owner_dept,remark)
  VALUES(coalesce(nullif(l.company,''),l.name),l.industry,l.region,l.source,'B','potential',l.phone,l.owner_id,l.owner_dept,'由线索 '||l.lead_no||' 转化') RETURNING id,crm_customer.cust_no INTO c_id,c_code;
  INSERT INTO crm_contact(customer_id,name,phone,is_primary) VALUES(c_id,l.name,l.phone,true);
  UPDATE crm_lead SET stage='converted',customer_id=c_id,converted_at=now(),in_pool=false,updated_at=now() WHERE id=p_id;
  RETURN QUERY SELECT c_id,c_code;
END $$;

CREATE FUNCTION crm_validate_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o crm_order%ROWTYPE; paid numeric; BEGIN
  SELECT * INTO o FROM crm_order WHERE id=NEW.order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '订单不存在或不在数据范围内' USING ERRCODE='23503'; END IF;
  IF o.status='refund' THEN RAISE EXCEPTION '已退款订单不能登记回款' USING ERRCODE='23514'; END IF;
  SELECT coalesce(sum(amount),0) INTO paid FROM crm_payment WHERE order_id=o.id AND id<>coalesce(NEW.id,0);
  IF paid+NEW.amount>o.amount THEN RAISE EXCEPTION '回款金额不能超过订单未收款金额' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_integrity BEFORE INSERT OR UPDATE ON crm_payment FOR EACH ROW EXECUTE FUNCTION crm_validate_payment();
CREATE FUNCTION crm_payment_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total_paid numeric; BEGIN
  SELECT coalesce(sum(amount),0) INTO total_paid FROM crm_payment WHERE order_id=NEW.order_id;
  UPDATE crm_order SET status='paid',pay_date=NEW.pay_date WHERE id=NEW.order_id AND status='pending' AND total_paid>=amount;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_status AFTER INSERT OR UPDATE ON crm_payment FOR EACH ROW EXECUTE FUNCTION crm_payment_status();

CREATE VIEW crm_order_balance WITH (security_invoker=true) AS
SELECT o.*,coalesce(p.paid,0) AS paid_amount,greatest(o.amount-coalesce(p.paid,0),0) AS unpaid_amount
FROM crm_order o LEFT JOIN LATERAL (SELECT sum(amount) AS paid FROM crm_payment WHERE order_id=o.id) p ON true;

CREATE TABLE crm_audit(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,table_name text NOT NULL,record_id integer NOT NULL,operation text NOT NULL,actor_id integer,actor_role text,before_data jsonb,after_data jsonb,occurred_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX audit_record_time ON crm_audit(table_name,record_id,occurred_at DESC);
CREATE INDEX audit_actor_time ON crm_audit(actor_id,occurred_at DESC);
CREATE INDEX audit_after_gin ON crm_audit USING gin(after_data jsonb_path_ops);
ALTER TABLE crm_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON crm_audit FOR SELECT USING(current_setting('crm.role',true) IN ('admin','system'));
CREATE FUNCTION crm_audit_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  INSERT INTO public.crm_audit(table_name,record_id,operation,actor_id,actor_role,before_data,after_data)
  VALUES(TG_TABLE_NAME,coalesce(NEW.id,OLD.id),TG_OP,nullif(current_setting('crm.user_id',true),'')::integer,current_setting('crm.role',true),CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END);
  RETURN coalesce(NEW,OLD);
END $$;
DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['crm_customer','crm_lead','crm_opportunity','crm_contract','crm_order','crm_payment','crm_follow_up'] LOOP
    EXECUTE format('CREATE TRIGGER audit_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION crm_audit_change()',tbl);
  END LOOP;
END $$;

CREATE TABLE bi_refresh_state(id integer PRIMARY KEY CHECK(id=1),source_version bigint NOT NULL DEFAULT 0,refreshed_version bigint NOT NULL DEFAULT 0,refreshed_at timestamptz);
INSERT INTO bi_refresh_state(id) VALUES(1);
CREATE MATERIALIZED VIEW bi_sales_daily AS
SELECT sign_date AS stat_date,coalesce(owner_id,0) AS owner_id,coalesce(owner_dept,'') AS owner_dept,
  coalesce(region,'未分区') AS region,count(*)::bigint AS contract_count,sum(amount) AS sales_amount,sum(cost) AS sales_cost
FROM crm_contract c LEFT JOIN LATERAL(SELECT region FROM crm_customer WHERE id=c.customer_id) cust ON true
WHERE status IN ('effective','closed') GROUP BY sign_date,coalesce(owner_id,0),coalesce(owner_dept,''),coalesce(region,'未分区');
CREATE UNIQUE INDEX sales_daily_identity ON bi_sales_daily(stat_date,owner_id,owner_dept,region);
CREATE INDEX sales_daily_owner_date ON bi_sales_daily(owner_id,stat_date);
CREATE INDEX sales_daily_dept_date ON bi_sales_daily(owner_dept,stat_date);
CREATE FUNCTION bi_mark_sales_dirty() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN UPDATE public.bi_refresh_state SET source_version=source_version+1 WHERE id=1; RETURN NULL; END $$;
CREATE TRIGGER sales_dirty AFTER INSERT OR UPDATE OR DELETE ON crm_contract FOR EACH STATEMENT EXECUTE FUNCTION bi_mark_sales_dirty();
CREATE TRIGGER customer_region_dirty AFTER UPDATE OF region OR DELETE ON crm_customer FOR EACH STATEMENT EXECUTE FUNCTION bi_mark_sales_dirty();

CREATE FUNCTION bi_refresh_sales() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version bigint; BEGIN
  IF coalesce(current_setting('crm.role',true),'') NOT IN ('admin','system') THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('crm-bi:sales-refresh')) THEN RETURN false; END IF;
  SELECT source_version INTO version FROM public.bi_refresh_state WHERE id=1;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.bi_sales_daily;
  UPDATE public.bi_refresh_state SET refreshed_version=version,refreshed_at=now() WHERE id=1;
  RETURN true;
END $$;
CREATE FUNCTION bi_sales_trend(p_from date,p_to date)
RETURNS TABLE(stat_date date,sales_amount numeric,contract_count bigint,profit numeric,running_amount numeric,previous_amount numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  WITH daily AS (SELECT dates::date AS day,coalesce(sum(s.sales_amount),0) AS amount,coalesce(sum(s.contract_count),0)::bigint AS count,coalesce(sum(s.sales_amount-s.sales_cost),0) AS profit
    FROM generate_series(p_from,p_to,interval '1 day') dates
    LEFT JOIN public.bi_sales_daily s ON s.stat_date=dates::date AND public.crm_scope_matches(s.owner_id,s.owner_dept)
    GROUP BY dates)
  SELECT day,amount,count,profit,sum(amount) OVER(ORDER BY day),lag(amount) OVER(ORDER BY day) FROM daily ORDER BY day
$$;

REVOKE ALL ON FUNCTION crm_sync_code_sequences(),bi_refresh_sales(),bi_sales_trend(date,date),crm_audit_change(),bi_mark_sales_dirty() FROM PUBLIC;
