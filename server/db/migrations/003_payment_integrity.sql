-- Keep invariants valid when data is written directly through PostgreSQL.
CREATE OR REPLACE FUNCTION crm_validate_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o crm_order%ROWTYPE; paid numeric; BEGIN
  IF TG_OP='UPDATE' AND NEW.order_id<>OLD.order_id THEN
    RAISE EXCEPTION '回款记录不能更换所属订单' USING ERRCODE='23514';
  END IF;
  SELECT * INTO o FROM crm_order WHERE id=NEW.order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '订单不存在或不在数据范围内' USING ERRCODE='23503'; END IF;
  IF o.status='refund' THEN RAISE EXCEPTION '已退款订单不能登记回款' USING ERRCODE='23514'; END IF;
  SELECT coalesce(sum(amount),0) INTO paid FROM crm_payment WHERE order_id=o.id AND id<>coalesce(NEW.id,0);
  IF paid+NEW.amount>o.amount THEN RAISE EXCEPTION '回款金额不能超过订单未收款金额' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION crm_validate_order_amount() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paid numeric; BEGIN
  SELECT coalesce(sum(amount),0) INTO paid FROM crm_payment WHERE order_id=NEW.id;
  IF NEW.amount<paid THEN RAISE EXCEPTION '订单金额不能低于累计回款' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER order_paid_integrity BEFORE UPDATE OF amount ON crm_order FOR EACH ROW EXECUTE FUNCTION crm_validate_order_amount();

CREATE OR REPLACE FUNCTION crm_payment_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total_paid numeric; order_key integer; BEGIN
  order_key := CASE WHEN TG_OP='DELETE' THEN OLD.order_id ELSE NEW.order_id END;
  -- Consistent lock order for payment deletion as well as inserts and updates.
  PERFORM 1 FROM crm_order WHERE id=order_key FOR UPDATE;
  SELECT coalesce(sum(amount),0) INTO total_paid FROM crm_payment WHERE order_id=order_key;
  UPDATE crm_order SET status='paid',pay_date=CASE WHEN TG_OP='DELETE' THEN pay_date ELSE NEW.pay_date END
    WHERE id=order_key AND status='pending' AND total_paid>=amount;
  UPDATE crm_order SET status='pending',pay_date=NULL WHERE id=order_key AND status='paid' AND total_paid<amount;
  RETURN coalesce(NEW,OLD);
END $$;
DROP TRIGGER payment_status ON crm_payment;
CREATE TRIGGER payment_status AFTER INSERT OR UPDATE OR DELETE ON crm_payment FOR EACH ROW EXECUTE FUNCTION crm_payment_status();

